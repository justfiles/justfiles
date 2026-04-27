// Host-side wiring for dynamic worker apps.
//
//   worker/dynamic/<id>/app.js          - App spec (engine + agent), bundled
//                                          into a per-app dynamic worker.
//   worker/dynamic/<id>/{*.html,*.js,…}  - assets, served by the host.
//   worker/dynamic/_bridge.js            - postMessage bridge auto-injected
//                                          into every served HTML.
//
// Apps are auto-registered at module load via Vite glob — drop a directory in
// and it's picked up. POC layout: bundles ship as inline strings via `?raw`.
// Production: swap the glob for an R2/KV-backed source with the same shape.

import { createWorker } from '@cloudflare/worker-bundler'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import Type from 'typebox'
import type { Action, Actor } from '../apps/engine'
import bridgeJs from './dynamic/_bridge.js?raw'
import type { App as FacetApp } from './dynamic/do.js'
import doCode from './dynamic/do.js?raw'

// Slim facet RPC contract — hand-written to keep TS inference shallow.
// Mirrors the shape of class App in worker/dynamic/do.js.
export interface AppFacet {
	dispatch(action: Action, actor: Actor): Promise<unknown>
	view(actor: Actor): Promise<unknown>
	allows(actor: Actor, action: Action): Promise<boolean>
	availableActions(actor: Actor): Promise<unknown>
	tools(): Promise<unknown>
	briefing(): Promise<string | null>
	done(): Promise<boolean>
}

const PACKAGE_JSON = JSON.stringify({ dependencies: { typebox: '^1.1.33' } })
const COMPAT_DATE = '2026-04-25'
const ENTRY = 'index.html'

type AppEntry = { code: string; assets: Record<string, string> }

const registry = ((): Map<string, AppEntry> => {
	const codes = import.meta.glob('./dynamic/*/app.js', {
		query: '?raw',
		import: 'default',
		eager: true
	}) as Record<string, string>
	const allAssets = import.meta.glob('./dynamic/*/**/*.{html,js,css,svg,json}', {
		query: '?raw',
		import: 'default',
		eager: true
	}) as Record<string, string>

	const out = new Map<string, AppEntry>()
	for (const [path, code] of Object.entries(codes)) {
		const dir = path.slice(0, -'/app.js'.length)
		const id = dir.split('/').pop()!
		const assets: Record<string, string> = {}
		for (const [aPath, content] of Object.entries(allAssets)) {
			if (aPath.startsWith(`${dir}/`) && !aPath.endsWith('/app.js')) {
				assets[aPath.slice(dir.length + 1)] = content
			}
		}
		out.set(id, { code, assets })
	}
	return out
})()

export const listAppIds = (): string[] => [...registry.keys()]
export const hasApp = (id: string): boolean => registry.has(id)
export const getAsset = (id: string, path: string): string | undefined =>
	registry.get(id)?.assets[path || ENTRY]
export const BRIDGE_JS = bridgeJs
export const ASSET_ENTRY = ENTRY

// First call per appId pays the bundle cost (esbuild-wasm + npm fetch for
// declared deps). Subsequent calls hit the worker-loader cache.
// TODO(prod): pre-bundle at deploy time and skip the runtime install path.
export function loadAppFacet(ctx: DurableObjectState, env: Env, appId: string): AppFacet {
	const entry = registry.get(appId)
	if (!entry) throw new Error(`unknown app: ${appId}`)
	const facet = ctx.facets.get<FacetApp>(appId, async () => {
		const worker = env.LOADER?.get(appId, async () => {
			const { mainModule, modules } = await createWorker({
				files: {
					'src/index.js': doCode,
					'src/app.js': entry.code,
					'package.json': PACKAGE_JSON
				},
				entryPoint: 'src/index.js'
			})
			return { mainModule, modules, compatibilityDate: COMPAT_DATE, globalOutbound: null }
		})
		return { class: worker!.getDurableObjectClass<FacetApp>('App') }
	})
	return facet as unknown as AppFacet
}
type ToolDescriptor = { name: string; description?: string; parameters: unknown }

// Synthesize callable AgentTools from facet's data-only descriptors.
// Tool names are namespaced `${appId}_${actionType}` to avoid collisions with
// other agent tools. `dispatch` is supplied by the caller so the supervisor
// can wrap facet.dispatch with broadcast/auth side-effects in one place.
export async function buildAppTools(
	facet: AppFacet,
	appId: string,
	actor: Actor,
	dispatch: (action: Action, actor: Actor) => Promise<unknown>
): Promise<AgentTool[]> {
	const descriptors = (await facet.tools()) as ToolDescriptor[]

	const wrap = (
		name: string,
		description: string,
		parameters: Type.TSchema,
		run: (payload: unknown) => Promise<unknown>
	): AgentTool => {
		const tool: AgentTool<typeof parameters> = {
			name: `${appId}_${name}`,
			label: `${appId}: ${name}`,
			description,
			parameters,
			async execute(_id, payload) {
				const result = await run(payload ?? {})
				return {
					content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
					details: result
				} satisfies AgentToolResult<unknown>
			}
		}
		return tool as unknown as AgentTool
	}

	const actionTools = descriptors.map((d) =>
		wrap(
			d.name,
			d.description ?? `Submit ${d.name} to ${appId}.`,
			d.parameters as Type.TSchema,
			(payload) => dispatch({ type: d.name, payload } as Action, actor)
		)
	)
	const availableActionsTool = wrap(
		'availableActions',
		`List actions currently legal for the actor.`,
		Type.Object({}),
		() => facet.availableActions(actor)
	)
	return [...actionTools, availableActionsTool]
}

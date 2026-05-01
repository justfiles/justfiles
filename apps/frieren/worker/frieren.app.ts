/// <reference types="@justfiles/app/virtual" />
//
// Host-side wiring for dynamic worker apps. The registry is the build-time
// virtual module emitted by `hostApps()` in vite.config.ts (see
// @justfiles/app/vite). Each entry carries `manifest`, `code` (backend ESM),
// and a flat `assets` map — the same shape regardless of source.
//
// Production: in addition to the build-time `hostApps` channel, frieren will
// load user-uploaded apps from R2 at runtime via `installFromR2`. Both paths
// converge on `loadAppPackage` (see @justfiles/app/host) and yield the same
// `AppEntry`, so the registry consumer doesn't have to care which source.

import { registry } from 'virtual:@justfiles/apps'
import { createWorker } from '@cloudflare/worker-bundler'
import type { Action, Actor } from '@justfiles/app'
import bridgeJs from '@justfiles/app/client?raw'
import type { AppEntry } from '@justfiles/app/host'
import runtimeJs from '@justfiles/app/runtime.js?raw'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import Type from 'typebox'
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
	reset(): Promise<unknown>
}

const PACKAGE_JSON = JSON.stringify({ dependencies: { typebox: '^1.1.33' } })
const COMPAT_DATE = '2026-04-25'

export const listAppIds = (): string[] => [...registry.keys()]
export const listApps = (): { id: string; name: string; description: string; iconUrl?: string }[] =>
	[...registry.entries()].map(([id, entry]) => ({
		id,
		name: entry.manifest.name,
		description: entry.manifest.description,
		iconUrl: entry.manifest.icon ? `/apps/${id}/${entry.manifest.icon}` : undefined
	}))
export const hasApp = (id: string): boolean => registry.has(id)
export const getAsset = (id: string, path: string): string | undefined => {
	const entry = registry.get(id)
	if (!entry) return undefined
	return entry.assets[path || entry.manifest.entry]
}
export const getEntryPath = (id: string): string | undefined => registry.get(id)?.manifest.entry
export const BRIDGE_JS = bridgeJs

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
					'src/runtime.js': runtimeJs,
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

// TODO(uploads): runtime adapter for user-submitted apps. Reads every key
// under `prefix` from R2, decodes utf-8 (binary assets blocked at upload
// time per format.ts TODO), and feeds the bag to `loadAppPackage`. Same
// `AppEntry` returned, same downstream wiring.
export async function installFromR2(_prefix: string): Promise<AppEntry> {
	throw new Error('installFromR2: not implemented')
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

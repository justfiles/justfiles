/// <reference types="@justfiles/app/virtual" />
//
// Host-side wiring for dynamic worker apps. The build-time virtual module
// (emitted by `hostApps()` in vite.config.ts; see @justfiles/app/vite) gives
// us {manifest, code} per app — small data the worker bundles. The bytes
// for HTML/JS/CSS/wasm/wad ship via Workers Static Assets under
// `/apps/<id>/<path>` and are streamed through `c.env.ASSETS` by the
// `/apps/*` route in `index.ts`.
//
// Production: in addition to the build-time `hostApps` channel, frieren will
// load user-uploaded apps from R2 at runtime via `installFromR2`. Both paths
// can converge on `loadAppPackage` with their own `AppPackageSource`.

import { registry } from 'virtual:@justfiles/apps'
import { createWorker } from '@cloudflare/worker-bundler'
import type { Action, Actor, AppPermission } from '@justfiles/app'
import capBridgeJs from '@justfiles/app/capabilities-bridge.js?raw'
import bridgeJs from '@justfiles/app/client?raw'
import runnerJs from '@justfiles/app/runner.js?raw'
import runtimeJs from '@justfiles/app/runtime.js?raw'
import sdkJs from '@justfiles/app/sdk?raw'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import Type from 'typebox'
import { AppBridge, type AppFacetScope, appLoaderCacheKey } from './app-bridge'
import type { App as FacetApp } from './dynamic/do.js'
import doCode from './dynamic/do.js?raw'

// Slim facet RPC contract — hand-written to keep TS inference shallow.
// Mirrors the shape of class App in worker/dynamic/do.js.
export interface AppFacet {
	dispatch(action: Action, actor: Actor): Promise<unknown>
	view(actor: Actor): Promise<unknown>
	allows(actor: Actor, action: Action): Promise<boolean>
	availableActions(actor: Actor): Promise<unknown>
	tools(actor?: Actor): Promise<unknown>
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
export const getEntryPath = (id: string): string | undefined => registry.get(id)?.manifest.entry
// Client-only apps ship just static assets — no backend module, no
// state-machine facet. The launcher still opens them in the iframe host;
// the parent skips facet load, tool registration, and dispatch.
export const isClientApp = (id: string): boolean => !registry.get(id)?.manifest.backend
// Manifest-declared permissions for an app. Default-deny — an unknown id
// or a manifest without the field returns an empty list, which the RPC
// dispatcher gates volume calls against.
export const getAppPermissions = (id: string): readonly AppPermission[] =>
	registry.get(id)?.manifest.permissions ?? []
export const BRIDGE_JS = bridgeJs
export const SDK_JS = sdkJs

// First call per (appId, version, user, grants) pays the bundle cost
// (esbuild-wasm + npm fetch for declared deps). Subsequent calls hit the
// worker-loader cache. The cache key fences sandboxes per user and grant
// set so a sandbox is never reused across versions, users, or grants.
// `env.APP_BRIDGE` ships a `WorkerEntrypoint`-style RPC stub (see
// `app-bridge.ts`) the dynamic worker reads to invoke broker-backed
// capabilities; sandbox egress stays closed via `globalOutbound: null`.
// TODO(prod): pre-bundle at deploy time and skip the runtime install path.
export function loadAppFacet(
	ctx: DurableObjectState,
	env: Env,
	appId: string,
	scope: AppFacetScope
): AppFacet {
	const entry = registry.get(appId)
	if (!entry) throw new Error(`unknown app: ${appId}`)
	const cacheKey = appLoaderCacheKey({
		appId,
		version: entry.manifest.version,
		userId: scope.userId,
		grants: scope.grants
	})
	const facet = ctx.facets.get<FacetApp>(cacheKey, async () => {
		const worker = env.LOADER?.get(cacheKey, async () => {
			const { mainModule, modules } = await createWorker({
				files: {
					'src/index.js': doCode,
					'src/app.js': entry.code,
					'src/runtime.js': runtimeJs,
					'src/runner.js': runnerJs,
					'src/capabilities-bridge.js': capBridgeJs,
					'package.json': PACKAGE_JSON
				},
				entryPoint: 'src/index.js'
			})
			return {
				mainModule,
				modules,
				compatibilityDate: COMPAT_DATE,
				globalOutbound: null,
				env: { APP_BRIDGE: new AppBridge(scope.bridge) }
			}
		})
		if (!worker) throw new Error('LOADER binding is required')
		return { class: worker.getDurableObjectClass<FacetApp>('App') }
	})
	return facet as unknown as AppFacet
}

// TODO(uploads): runtime adapter for user-submitted apps. Wraps an R2
// bucket as an AppPackageSource (open() → bucket.get(prefix+path), returning
// the streamed body) and feeds it to `loadAppPackage`. Same AppEntry shape,
// streaming end-to-end.
export async function installFromR2(_prefix: string): Promise<never> {
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
	const descriptors = (await facet.tools(actor)) as ToolDescriptor[]

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

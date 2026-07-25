import type { ActionMeta } from './app.ts'
import type { Kernel } from './kernel.ts'

// A launcher/agent-facing view of an installed app.
export interface AppSummary {
	id: string
	name: string
	description?: string
}

export interface AppInspection extends AppSummary {
	state: unknown
	actions: Record<string, ActionMeta>
}

// The agent↔kernel bridge: list/launch/inspect/close/state/run against a kernel.
// The `app` command (@justfiles/agent) and the launcher both drive it; a host used
// to hand-write this near-verbatim (native macOS bundles on spud-mac, DO-backed
// apps on frieren) — `createAppController` is the single implementation.
export interface AppController {
	list(): Promise<AppSummary[]>
	launch(id: string): Promise<AppInspection>
	close(id?: string): Promise<void>
	current(): Promise<AppInspection | undefined>
	inspect(id: string): Promise<AppInspection>
	state(id: string): Promise<unknown>
	run(id: string, action: string, params: unknown): Promise<unknown>
}

// The platform-specific seam the controller closes over.
export interface AppControllerPorts {
	// Bring an app to the foreground / dismiss it. spud-mac `open`/`pkill`s a native
	// bundle (needs the name); frieren broadcasts open/close to its tabs (needs the id).
	windows: {
		open(id: string, name: string): void
		close(id: string, name: string): void
	}
	// Resolve the "current" app id. Omit to track the last-launched id in memory
	// (spud-mac's approximation of focus); frieren reads it from its persisted OS state.
	focus?: () => Promise<string | undefined>
}

// Build the AppController over a kernel. `kernel` may be a ready instance or an
// accessor — frieren builds it lazily and reconciles built-ins on first use, so it
// passes a thunk; spud-mac's is pre-built. Preview apps are hidden from `list`, `run`
// stamps the agent as the actor, and `current`/`close` resolve the focused app.
export function createAppController(
	kernel: Kernel | (() => Promise<Kernel>),
	ports: AppControllerPorts
): AppController {
	const resolve = typeof kernel === 'function' ? kernel : () => Promise.resolve(kernel)
	let lastLaunched: string | undefined
	const focus = ports.focus ?? (() => Promise.resolve(lastLaunched))
	// A synced host may receive state writes outside its kernel. Reload on the
	// per-app queue so agent reads and dispatches start from the persisted value.
	// This is a redundant read on sole-writer hosts, but keeps the controller lean.
	const reloaded = async (id: string): Promise<Kernel> => {
		const k = await resolve()
		await k.reload(id)
		return k
	}

	const inspect = async (id: string): Promise<AppInspection> => {
		const k = await reloaded(id)
		const [installed, state, actions] = await Promise.all([
			k.app(id),
			k.state(id).catch(() => undefined),
			k.actions(id)
		])
		return {
			id: installed.manifest.id,
			name: installed.manifest.name,
			description: installed.manifest.description ?? '',
			state: state ?? null,
			actions
		}
	}

	return {
		list: async () =>
			(await (await resolve()).list())
				.filter((m) => !m.id.startsWith('preview.'))
				.map((m) => ({ id: m.id, name: m.name, description: m.description ?? '' })),
		launch: async (id) => {
			const app = await inspect(id)
			ports.windows.open(id, app.name)
			lastLaunched = id
			return app
		},
		close: async (id) => {
			const target = id ?? (await focus())
			if (!target) return
			const name = await (await resolve()).app(target).then(
				(a) => a.manifest.name,
				() => target
			)
			ports.windows.close(target, name)
			if (target === lastLaunched) lastLaunched = undefined
		},
		current: async () => {
			const id = await focus()
			return id ? await inspect(id).catch(() => undefined) : undefined
		},
		inspect,
		state: async (id) => (await reloaded(id)).state(id),
		run: async (id, action, params) =>
			(await reloaded(id)).dispatch(id, { type: action, params, actor: 'agent' })
	}
}

import { type AppBundle, type Kernel, kernel, safeBundlePath } from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import { bundleFromZip } from '../shared/app-bundle.ts'
import { appFileUrl, CATALOG_PATH, type Catalog, reconcileBuiltins } from '../shared/appstore.ts'
import { capabilityError, toWireError } from '../shared/capability-error.ts'
import { invokeVolume } from '../shared/volume.capability.ts'
import type { AppController } from './bash/commands/app.ts'
import type { Integrations } from './integrations/registry.ts'
import { invokeIntegrations } from './integrations.capability.ts'
import { workerSandbox } from './kernel.sandbox.ts'
import type { LLMText } from './llm.text.ts'

interface DisplayApp {
	readonly id: string
	readonly name: string
	readonly description: string
	readonly iconUrl?: string
}

type AppBroadcast = { type: 'app_open'; id: string } | { type: 'app_close'; id: string }

interface FrierenAppsDeps {
	fs: Volume
	loader: Parameters<typeof workerSandbox>[0] | undefined
	// Static assets binding — serves the `/appstore` built-in app files seeded
	// into the volume on boot.
	assets: Fetcher
	sockets: () => Iterable<WebSocket>
	acceptWebSocket: (ws: WebSocket) => void
	text: LLMText
	broadcast: (msg: AppBroadcast) => void
	// Lazily resolved so frierenApps can be constructed before the
	// integrations registry exists; the volume capability does not need it.
	integrations?: () => Integrations
}

export interface FrierenApps {
	readonly kernel: Kernel
	readonly controller: AppController
	bundleFromZip(zip: Uint8Array): AppBundle
	list(): Promise<readonly DisplayApp[]>
	open(id: string): Promise<void>
	close(id?: string): Promise<void>
	asset(appId: string, path: string, version?: string): Promise<Response>
	acceptWebSocket(appId: string): Promise<Response>
	handleMessage(
		ws: WebSocket,
		appId: string | undefined,
		message: string | ArrayBuffer
	): Promise<void>
}

const OS_STATE_PATH = '/system/os-state.json'
const DEV_BUILTINS = import.meta.env.DEV

// Reserved pseudo-app id for the single shared capability-proxy socket. Not a
// valid app id (underscore is disallowed by the kernel), so it can't collide
// with a real app. The browser kernel opens ONE of these for every app's
// proxied capability calls; the target app id rides each frame.
const CAPS_SOCKET = '_caps'

export function frierenApps(deps: FrierenAppsDeps): FrierenApps {
	let kernelInstance: Kernel | undefined
	let subscribed = false
	let builtinsReady: Promise<void> | undefined

	function getKernel(): Kernel {
		if (kernelInstance) return kernelInstance
		if (!deps.loader) throw new Error('LOADER binding unavailable')
		kernelInstance = kernel({
			fs: deps.fs,
			sandbox: workerSandbox(deps.loader),
			clock: {},
			capabilityInvoke: invokeCapability
		})
		return kernelInstance
	}

	// Built-in apps live as static `/appstore` assets and are seeded into the
	// user's volume on kernel use (this DO is the sole materializer for the synced
	// profile — see shared/appstore.ts). reconcileBuiltins reinstalls only the apps
	// whose bytes changed, so dev re-checks on every kernel use to pick up local
	// edits (cheap — unchanged apps are skipped); prod runs it once per instance.
	async function ensureBuiltinsInstalled(k: Kernel): Promise<void> {
		if (DEV_BUILTINS) return reconcileFromAssets(k)
		if (!builtinsReady) builtinsReady = reconcileFromAssets(k)
		return builtinsReady
	}

	async function reconcileFromAssets(k: Kernel): Promise<void> {
		const res = await deps.assets.fetch(assetRequest(CATALOG_PATH))
		if (!res.ok) return
		const catalog = (await res.json()) as Catalog
		await reconcileBuiltins(k, deps.fs, catalog, async (app, path) => {
			const file = await deps.assets.fetch(assetRequest(appFileUrl(app, path)))
			if (!file.ok) throw new Error(`appstore: ${app.id}/${path} ${file.status}`)
			return new Uint8Array(await file.arrayBuffer())
		})
	}

	async function kernelReady(): Promise<Kernel> {
		const k = getKernel()
		await ensureBuiltinsInstalled(k)
		return k
	}

	async function invokeCapability(req: {
		capability: string
		method: string
		input: unknown
		scopes: readonly string[]
		appId: string
		actor?: string
	}): Promise<unknown> {
		if (req.capability === 'ai' && req.method === 'generateText') {
			const input = req.input as { system?: unknown; prompt?: unknown }
			if (!input || typeof input !== 'object' || typeof input.prompt !== 'string') {
				throw capabilityError('CAPABILITY_INVALID_INPUT', req.capability, req.method)
			}
			return {
				text: await deps.text.gen(
					typeof input.system === 'string' ? input.system : '',
					input.prompt
				)
			}
		}
		if (req.capability === 'volume') {
			return invokeVolume(deps.fs, req)
		}
		if (req.capability === 'integrations') {
			const registry = deps.integrations?.()
			if (!registry) throw capabilityError('CAPABILITY_UNAVAILABLE', req.capability, req.method)
			return invokeIntegrations(registry, req)
		}
		throw capabilityError('CAPABILITY_UNAVAILABLE', req.capability, req.method)
	}

	// kernel.subscribe's handler is in-memory, so it dies with the DO on
	// hibernation. Re-registered lazily per instance. On the server kernel
	// `app.update` fires only for the agent's own dispatches, so it nudges every
	// caps socket to pull: the agent changed this app server-side; pull now
	// instead of waiting for the next sync interval. The browser kernel renders
	// the pulled state via `volume.watch`.
	function ensureSubscribed(): void {
		if (subscribed) return
		subscribed = true
		getKernel().subscribe((event) => {
			if (event.type !== 'app.update') return
			const dirtyFrame = JSON.stringify({ type: 'dirty', appId: event.appId })
			for (const socket of deps.sockets()) {
				const attachment = socket.deserializeAttachment() as { caps?: boolean } | null
				if (attachment?.caps) socket.send(dirtyFrame)
			}
		})
	}

	async function inspect(id: string) {
		const k = await kernelReady()
		const installed = await k.app(id)
		const [state, actions] = await Promise.all([k.state(id).catch(() => undefined), k.actions(id)])
		return {
			id: installed.manifest.id,
			name: installed.manifest.name,
			description: '',
			state: state ?? null,
			actions
		}
	}

	async function list(): Promise<readonly DisplayApp[]> {
		try {
			const manifests = await (await kernelReady()).list()
			return manifests.map((m) => ({
				id: m.id,
				name: m.name,
				description: m.description ?? '',
				iconUrl:
					m.icon && m.version ? appFileUrl({ id: m.id, version: m.version }, m.icon) : undefined
			}))
		} catch {
			return []
		}
	}

	async function currentAppId(): Promise<string | undefined> {
		try {
			if (!(await deps.fs.exists(OS_STATE_PATH))) return undefined
			const snapshot = JSON.parse(
				new TextDecoder().decode(await deps.fs.readFile(OS_STATE_PATH))
			) as {
				windows?: Record<string, { appId?: unknown } | undefined>
				focusStack?: unknown
				openOrder?: unknown
			}
			for (const ids of [snapshot.focusStack, snapshot.openOrder]) {
				if (!Array.isArray(ids)) continue
				for (let i = ids.length - 1; i >= 0; i--) {
					const id = ids[i]
					if (typeof id !== 'string') continue
					const appId = snapshot.windows?.[id]?.appId
					if (typeof appId === 'string') return appId
				}
			}
		} catch {
			return undefined
		}
		return undefined
	}

	async function open(id: string): Promise<void> {
		deps.broadcast({ type: 'app_open', id })
	}

	async function close(id?: string): Promise<void> {
		const target = id ?? (await currentAppId())
		if (!target) return
		deps.broadcast({ type: 'app_close', id: target })
	}

	async function asset(appId: string, path: string, version?: string): Promise<Response> {
		let safe: string
		try {
			safe = safeBundlePath(path)
		} catch {
			return new Response(null, { status: 404 })
		}
		try {
			const installed = await (await kernelReady()).app(appId)
			const data = await installed.read(safe)
			const body = new ArrayBuffer(data.byteLength)
			new Uint8Array(body).set(data)
			const headers: Record<string, string> = { 'content-type': mimeFor(safe) }
			if (DEV_BUILTINS) {
				headers['cache-control'] = 'no-store'
			} else if (version && installed.manifest.version && version === installed.manifest.version) {
				// When the URL pins the manifest version, the byte stream is
				// immutable for that URL — browsers re-use the cached entry on
				// re-launch within the token's lifetime, and a version bump in
				// list() drives a fresh fetch via a different URL.
				headers['cache-control'] = 'private, max-age=31536000, immutable'
			}
			return new Response(body, { headers })
		} catch {
			return new Response(null, { status: 404 })
		}
	}

	// ── Capability proxy transport ──────────────────────────────────────
	//
	// The browser kernel opens ONE caps socket (`/api/apps/_caps/ws`) per
	// session. It proxies every app's network capability calls (the app id rides
	// each frame) and receives the agent's `dirty` pulls.
	//   C→S  {"id":string,"appId":string,"capability":string,"method":string,"input":unknown}
	//   S→C  {"type":"result","id":string,"result":unknown}   (invoke reply)
	//        {"type":"error","id"?:string,"message":string,"code"?:string,...}
	//        {"type":"dirty","appId":string}                  (agent changed app, pull)

	async function acceptWebSocket(appId: string): Promise<Response> {
		// `_caps` is the only WS the browser opens here: no app id, no state push.
		if (appId !== CAPS_SOCKET) return new Response(null, { status: 404 })
		const { 0: client, 1: server } = new WebSocketPair()
		deps.acceptWebSocket(server)
		server.serializeAttachment({ caps: true })
		// Subscribe so the agent's server-side writes nudge this tab to pull.
		ensureSubscribed()
		return new Response(null, { status: 101, webSocket: client })
	}

	// `appId` is undefined for the shared caps socket — the target app id rides
	// each capability frame instead.
	async function handleMessage(
		ws: WebSocket,
		appId: string | undefined,
		message: string | ArrayBuffer
	): Promise<void> {
		if (typeof message !== 'string') return
		let request: {
			id?: string
			appId?: string
			capability?: string
			method?: string
			input?: unknown
		}
		try {
			request = JSON.parse(message)
		} catch {
			ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }))
			return
		}
		try {
			if (typeof request.capability === 'string' && typeof request.method === 'string') {
				const target = appId ?? request.appId
				if (!target) throw new Error('missing app')
				// `volume` is the only scope-bearing capability and is always served
				// by the browser kernel against the local volume — it must never be
				// proxied. Reject it explicitly rather than silently re-scoping.
				if (request.capability === 'volume')
					throw capabilityError('CAPABILITY_UNAVAILABLE', request.capability, request.method)
				const result = await invokeCapability({
					capability: request.capability,
					method: request.method,
					input: request.input,
					// Client-claimed scopes are never trusted here. The proxied
					// capabilities (ai/integrations) don't use scopes; scope
					// enforcement is deferred until a proxied capability needs it.
					scopes: [],
					appId: target
				})
				ws.send(JSON.stringify({ type: 'result', id: request.id, result }))
				return
			}
			throw new Error('invalid request')
		} catch (error) {
			ws.send(JSON.stringify({ type: 'error', id: request.id, ...toWireError(error) }))
		}
	}

	const controller: AppController = {
		list: async () =>
			(await list()).map(({ id, name, description }) => ({ id, name, description })),
		launch: async (id) => {
			const app = await inspect(id)
			await open(id)
			return app
		},
		close: async (id?: string) => {
			await close(id)
		},
		current: async () => {
			const id = await currentAppId()
			return id ? await inspect(id).catch(() => undefined) : undefined
		},
		inspect,
		state: async (id) => await (await kernelReady()).state(id),
		run: async (id, action, params) => {
			ensureSubscribed()
			return await (await kernelReady()).dispatch(id, { type: action, params, actor: 'agent' })
		}
	}

	return {
		get kernel() {
			return getKernel()
		},
		controller,
		bundleFromZip,
		list,
		open,
		close,
		asset,
		acceptWebSocket,
		handleMessage
	}
}

// The `ASSETS` binding ignores the host; only the path matters.
function assetRequest(path: string): Request {
	return new Request(`https://assets.invalid${path}`)
}

const MIME: Record<string, string> = {
	html: 'text/html; charset=utf-8',
	js: 'application/javascript; charset=utf-8',
	mjs: 'application/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	json: 'application/json; charset=utf-8',
	svg: 'image/svg+xml',
	wasm: 'application/wasm',
	wad: 'application/octet-stream',
	cfg: 'text/plain; charset=utf-8',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp'
}

function mimeFor(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase() ?? ''
	return MIME[ext] ?? 'application/octet-stream'
}

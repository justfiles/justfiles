import {
	type Action,
	type AppBundle,
	type AppManifest,
	type BuiltinBundle,
	type Kernel,
	kernel,
	safeBundlePath
} from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import { unzipSync } from 'fflate'
import { capabilityError, toWireError } from '../shared/capability-error.ts'
import { invokeVolume } from '../shared/volume.capability.ts'
import type { AppController } from './bash/commands/app.ts'
import { BUILTINS } from './builtins/index.ts'
import type { Integrations } from './integrations/registry.ts'
import { invokeIntegrations } from './integrations.capability.ts'
import { workerSandbox } from './kernel.sandbox.ts'
import type { LLMText } from './llm.text.ts'

interface DisplayApp {
	readonly id: string
	readonly name: string
	readonly description: string
	readonly iconUrl?: string
	// Version-stamped gui URL. Prod uses manifest.version for immutable caching;
	// dev uses a changing stamp to bypass the browser module cache.
	readonly guiUrl?: string
}

type AppBroadcast = { type: 'app_open'; id: string } | { type: 'app_close'; id: string }

interface FrierenAppsDeps {
	fs: Volume
	loader: Parameters<typeof workerSandbox>[0] | undefined
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
	let devAssetRevision = 0

	function getKernel(): Kernel {
		if (kernelInstance) return kernelInstance
		if (!deps.loader) throw new Error('LOADER binding unavailable')
		kernelInstance = kernel({
			fs: deps.fs,
			sandbox: workerSandbox(deps.loader, { capabilities: invokeCapability }),
			clock: {}
		})
		return kernelInstance
	}

	// Bundled built-in apps install themselves into the user's volume on kernel
	// use. Dev always overwrites bytes so local bundle changes show up without a
	// package version bump; prod keeps the cheap version-diff path.
	async function ensureBuiltinsInstalled(k: Kernel): Promise<void> {
		if (BUILTINS.length === 0) return
		if (DEV_BUILTINS) {
			await installBuiltins(k, true)
			return
		}
		if (!builtinsReady) builtinsReady = installBuiltins(k, false)
		return builtinsReady
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
	// hibernation. Re-registered lazily per instance; it fans `app.update`
	// to every live socket whose attachment appId matches the event.
	function ensureSubscribed(): void {
		if (subscribed) return
		subscribed = true
		getKernel().subscribe((event) => {
			if (event.type !== 'app.update') return
			const stateFrame = JSON.stringify({ type: 'state', state: event.state })
			// Content-free nudge for browser-kernel tabs: the agent changed this app
			// server-side; pull now instead of waiting for the next sync interval.
			const dirtyFrame = JSON.stringify({ type: 'dirty', appId: event.appId })
			for (const socket of deps.sockets()) {
				const attachment = socket.deserializeAttachment() as {
					appId?: string
					caps?: boolean
				} | null
				if (attachment?.caps) socket.send(dirtyFrame)
				else if (attachment?.appId === event.appId) socket.send(stateFrame)
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
			const devVersion = DEV_BUILTINS ? `dev-${++devAssetRevision}` : undefined
			return manifests.map((m) => {
				const version = devVersion ?? m.version
				return {
					id: m.id,
					name: m.name,
					description: m.description ?? '',
					iconUrl: m.icon ? assetUrl(m.id, m.icon, version) : undefined,
					guiUrl: assetUrl(m.id, 'gui.js', version)
				}
			})
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

	// ── App transport ───────────────────────────────────────────────────
	//
	// Two socket shapes share this DO:
	//   • per-app socket (`/api/apps/<id>/ws`) — server-kernel apps. Carries
	//     dispatches and push state; app id is fixed by the socket.
	//   • caps socket (`/api/apps/_caps/ws`) — ONE per browser kernel, proxies
	//     every app's network capability calls; the app id rides each frame.
	//   C→S  {"id":string,"action":{"type":string,"params":unknown}}      (per-app)
	//        {"id":string,"appId":string,"capability":string,"method":string,"input":unknown}
	//   S→C  {"type":"state","state":unknown}                 (push, per-app)
	//        {"type":"result","id":string,"result":unknown}   (invoke reply)
	//        {"type":"error","id"?:string,"message":string,"code"?:string,...}

	async function acceptWebSocket(appId: string): Promise<Response> {
		const k = await kernelReady()
		const { 0: client, 1: server } = new WebSocketPair()
		deps.acceptWebSocket(server)
		if (appId === CAPS_SOCKET) {
			// Capability proxy + `dirty` push target: no app id, no state push, no
			// snapshot. Subscribe so the agent's server-side writes nudge this tab.
			server.serializeAttachment({ caps: true })
			ensureSubscribed()
			return new Response(null, { status: 101, webSocket: client })
		}
		server.serializeAttachment({ appId })
		ensureSubscribed()
		// Always emit a snapshot frame on connect — both as the reconciliation
		// snapshot for a reload and as the "ready to mount" signal for a fresh
		// GUI. State may be `null` for never-dispatched apps; the GUI passes
		// that through to its mount() and renders whatever bootstrap it wants.
		const snapshot = await k.state(appId).catch(() => undefined)
		server.send(JSON.stringify({ type: 'state', state: snapshot ?? null }))
		return new Response(null, { status: 101, webSocket: client })
	}

	// `appId` is the socket-fixed id for a per-app socket, or undefined for the
	// shared caps socket (where it rides each capability frame instead).
	async function handleMessage(
		ws: WebSocket,
		appId: string | undefined,
		message: string | ArrayBuffer
	): Promise<void> {
		if (typeof message !== 'string') return
		let request: {
			id?: string
			action?: Action
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
			if (request.action) {
				if (!appId) throw new Error('missing app')
				ensureSubscribed()
				const result = await (await kernelReady()).dispatch(appId, request.action)
				ws.send(JSON.stringify({ type: 'result', id: request.id, result }))
				return
			}
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

async function installBuiltins(k: Kernel, force: boolean): Promise<void> {
	const installed = force ? undefined : new Map((await k.list()).map((m) => [m.id, m.version]))
	for (const builtin of BUILTINS) {
		if (installed?.get(builtin.id) === builtin.version) continue
		await k.install(bundleFromBuiltin(builtin))
	}
}

function assetUrl(appId: string, path: string, version?: string): string {
	return `/api/apps/${appId}/${path}${version ? `?v=${encodeURIComponent(version)}` : ''}`
}

function bundleFromBuiltin(builtin: BuiltinBundle): AppBundle {
	return {
		async manifest() {
			return builtin.manifest
		},
		async *list() {
			yield* Object.keys(builtin.files)
		},
		async read(path) {
			const bytes = builtin.files[safeBundlePath(path)]
			if (!bytes) throw new Error(`file not found: ${path}`)
			return bytes
		}
	}
}

function bundleFromZip(zip: Uint8Array): AppBundle {
	const rawEntries = Object.entries(unzipSync(zip))
	const entries = rawEntries.filter(
		([path]) => !path.endsWith('/') && !rawEntries.some(([other]) => other.startsWith(`${path}/`))
	)
	const prefix = entries.some(([path]) => path === 'manifest.json')
		? ''
		: commonTopLevelPrefix(entries.map(([path]) => path))
	const map = new Map<string, Uint8Array>()
	for (const [path, bytes] of entries)
		map.set(safeBundlePath(prefix ? path.slice(prefix.length) : path), bytes)
	return {
		async manifest() {
			const bytes = map.get('manifest.json')
			if (!bytes) throw new Error('missing manifest.json')
			return JSON.parse(new TextDecoder().decode(bytes)) as AppManifest
		},
		async *list() {
			yield* map.keys()
		},
		async read(path) {
			const bytes = map.get(safeBundlePath(path))
			if (!bytes) throw new Error(`file not found: ${path}`)
			return bytes
		}
	}
}

function commonTopLevelPrefix(paths: string[]): string {
	const roots = new Set(paths.map((path) => path.split('/')[0]).filter(Boolean))
	if (roots.size !== 1) return ''
	const prefix = `${[...roots][0]}/`
	return paths.includes(`${prefix}manifest.json`) ? prefix : ''
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

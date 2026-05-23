import {
	type Action,
	type AppBundle,
	type AppManifest,
	type Kernel,
	kernel,
	safeBundlePath
} from '@justfiles/app'
import type { Volume } from '@justfiles/fs'
import { unzipSync } from 'fflate'
import type { AppController } from './bash/commands/app.ts'
import { workerSandbox } from './kernel.sandbox.ts'
import type { LLMText } from './llm.text.ts'

interface DisplayApp {
	readonly id: string
	readonly name: string
	readonly description: string
	readonly iconUrl?: string
	readonly kind: 'builtin' | 'app'
}

type AppBroadcast = { type: 'kernel_app_open'; id: string } | { type: 'kernel_app_close' }

interface FrierenAppsDeps {
	fs: Volume
	loader: Parameters<typeof workerSandbox>[0] | undefined
	storage: DurableObjectStorage
	sockets: () => Iterable<WebSocket>
	acceptWebSocket: (ws: WebSocket) => void
	text: LLMText
	broadcast: (msg: AppBroadcast) => void
}

export interface FrierenApps {
	readonly kernel: Kernel
	readonly controller: AppController
	bundleFromZip(zip: Uint8Array): AppBundle
	list(): Promise<readonly DisplayApp[]>
	currentId(): Promise<string | undefined>
	open(id: string): Promise<void>
	close(): Promise<void>
	asset(appId: string, path: string): Promise<Response>
	acceptWebSocket(appId: string): Promise<Response>
	handleMessage(ws: WebSocket, appId: string, message: string | ArrayBuffer): Promise<void>
}

const CURRENT_KERNEL_APP_STORAGE_KEY = 'current_kernel_app'

export function frierenApps(deps: FrierenAppsDeps): FrierenApps {
	let kernelInstance: Kernel | undefined
	let subscribed = false

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

	async function invokeCapability(req: {
		capability: string
		method: string
		input: unknown
		appId: string
		actor?: string
	}): Promise<unknown> {
		if (req.capability !== 'ai' || req.method !== 'generateText') {
			throw capabilityError('CAPABILITY_UNAVAILABLE', req.capability, req.method)
		}
		const input = req.input as { system?: unknown; prompt?: unknown }
		if (!input || typeof input !== 'object' || typeof input.prompt !== 'string') {
			throw capabilityError('CAPABILITY_INVALID_INPUT', req.capability, req.method)
		}
		return {
			text: await deps.text.gen(typeof input.system === 'string' ? input.system : '', input.prompt)
		}
	}

	// kernel.subscribe's handler is in-memory, so it dies with the DO on
	// hibernation. Re-registered lazily per instance; it fans `app.update`
	// to every live socket whose attachment appId matches the event.
	function ensureSubscribed(): void {
		if (subscribed) return
		subscribed = true
		getKernel().subscribe((event) => {
			if (event.type !== 'app.update') return
			const frame = JSON.stringify({ type: 'state', state: event.state })
			for (const socket of deps.sockets()) {
				const attachment = socket.deserializeAttachment() as { appId?: string } | null
				if (attachment?.appId === event.appId) socket.send(frame)
			}
		})
	}

	async function inspect(id: string) {
		const k = getKernel()
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
			const manifests = await getKernel().list()
			return manifests.map((m) => ({
				id: m.id,
				name: m.name,
				description: m.description ?? '',
				iconUrl: m.icon ? `/api/kernel/${m.id}/${m.icon}` : undefined,
				kind: 'app' as const
			}))
		} catch {
			return []
		}
	}

	async function currentId(): Promise<string | undefined> {
		return (await deps.storage.get<{ id: string }>(CURRENT_KERNEL_APP_STORAGE_KEY))?.id
	}

	async function open(id: string): Promise<void> {
		await deps.storage.put(CURRENT_KERNEL_APP_STORAGE_KEY, { id })
		deps.broadcast({ type: 'kernel_app_open', id })
	}

	async function close(): Promise<void> {
		await deps.storage.delete(CURRENT_KERNEL_APP_STORAGE_KEY)
		deps.broadcast({ type: 'kernel_app_close' })
	}

	async function asset(appId: string, path: string): Promise<Response> {
		let safe: string
		try {
			safe = safeBundlePath(path)
		} catch {
			return new Response(null, { status: 404 })
		}
		try {
			const installed = await getKernel().app(appId)
			const data = await installed.read(safe)
			const body = new ArrayBuffer(data.byteLength)
			new Uint8Array(body).set(data)
			return new Response(body, { headers: { 'content-type': mimeFor(safe) } })
		} catch {
			return new Response(null, { status: 404 })
		}
	}

	// ── Kernel app transport ─────────────────────────────────────────────
	//
	// One per-user WebSocket carries the SDK `Transport` both ways:
	//   C→S  {"id":string,"action":{"type":string,"params":unknown}}
	//   S→C  {"type":"state","state":unknown}                 (push)
	//        {"type":"result","id":string,"result":unknown}   (invoke reply)
	//        {"type":"error","id"?:string,"message":string}
	// State is push-only (kernel.subscribe → app.update); the `result` frame
	// only resolves the correlated `invoke` promise — same contract the dev
	// server proves over REST+SSE, here over a single hibernatable socket.

	async function acceptWebSocket(appId: string): Promise<Response> {
		const k = getKernel()
		const { 0: client, 1: server } = new WebSocketPair()
		deps.acceptWebSocket(server)
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

	async function handleMessage(
		ws: WebSocket,
		appId: string,
		message: string | ArrayBuffer
	): Promise<void> {
		if (typeof message !== 'string') return
		let request: { id?: string; action?: Action }
		try {
			request = JSON.parse(message)
		} catch {
			ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }))
			return
		}
		ensureSubscribed()
		try {
			const result = await getKernel().dispatch(appId, request.action as Action)
			ws.send(JSON.stringify({ type: 'result', id: request.id, result }))
		} catch (error) {
			ws.send(
				JSON.stringify({
					type: 'error',
					id: request.id,
					message: error instanceof Error ? error.message : String(error)
				})
			)
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
		close,
		current: async () => {
			const id = await currentId()
			return id ? await inspect(id).catch(() => undefined) : undefined
		},
		inspect,
		state: async (id) => await getKernel().state(id),
		run: async (id, action, params) => {
			ensureSubscribed()
			return await getKernel().dispatch(id, { type: action, params, actor: 'agent' })
		}
	}

	return {
		get kernel() {
			return getKernel()
		},
		controller,
		bundleFromZip,
		list,
		currentId,
		open,
		close,
		asset,
		acceptWebSocket,
		handleMessage
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

function capabilityError(code: string, capability: string, method: string): Error {
	return Object.assign(new Error(code), { code, capability, method })
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

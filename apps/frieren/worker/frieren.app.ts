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
import type { AppController } from './bash/commands/app.ts'
import { BUILTINS } from './builtins/index.ts'
import type { Integrations } from './integrations/registry.ts'
import { invokeIntegrations } from './integrations.capability.ts'
import { workerSandbox } from './kernel.sandbox.ts'
import type { LLMText } from './llm.text.ts'
import { invokeVolume } from './volume.capability.ts'

interface DisplayApp {
	readonly id: string
	readonly name: string
	readonly description: string
	readonly iconUrl?: string
	// Version-stamped gui URL when the manifest has a version. Pairs with the
	// asset() handler, which sets immutable Cache-Control for matching v=.
	readonly guiUrl?: string
	readonly kind: 'builtin' | 'app'
}

type AppBroadcast =
	| { type: 'kernel_app_open'; id: string }
	| { type: 'kernel_app_close'; id: string }

interface FrierenAppsDeps {
	fs: Volume
	loader: Parameters<typeof workerSandbox>[0] | undefined
	storage: DurableObjectStorage
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
	openIds(): Promise<string[]>
	open(id: string): Promise<void>
	close(id?: string): Promise<void>
	asset(appId: string, path: string, version?: string): Promise<Response>
	acceptWebSocket(appId: string): Promise<Response>
	handleMessage(ws: WebSocket, appId: string, message: string | ArrayBuffer): Promise<void>
}

const OPEN_KERNEL_APPS_STORAGE_KEY = 'open_kernel_apps'

export function frierenApps(deps: FrierenAppsDeps): FrierenApps {
	let kernelInstance: Kernel | undefined
	let subscribed = false
	let builtinsReady: Promise<void> | undefined

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

	// Bundled built-in apps install themselves into the user's volume on the
	// first kernel use per DO instance. After the first run the version diff
	// short-circuits to a single `kernel.list()` read.
	async function ensureBuiltinsInstalled(k: Kernel): Promise<void> {
		if (!builtinsReady) {
			builtinsReady = (async () => {
				if (BUILTINS.length === 0) return
				const installed = new Map((await k.list()).map((m) => [m.id, m.version]))
				for (const builtin of BUILTINS) {
					if (installed.get(builtin.id) === builtin.version) continue
					await k.install(bundleFromBuiltin(builtin))
				}
			})()
		}
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
			const frame = JSON.stringify({ type: 'state', state: event.state })
			for (const socket of deps.sockets()) {
				const attachment = socket.deserializeAttachment() as { appId?: string } | null
				if (attachment?.appId === event.appId) socket.send(frame)
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
				iconUrl: m.icon
					? `/api/kernel/${m.id}/${m.icon}${m.version ? `?v=${encodeURIComponent(m.version)}` : ''}`
					: undefined,
				guiUrl: m.version
					? `/api/kernel/${m.id}/gui.js?v=${encodeURIComponent(m.version)}`
					: `/api/kernel/${m.id}/gui.js`,
				kind: 'app' as const
			}))
		} catch {
			return []
		}
	}

	async function openIds(): Promise<string[]> {
		return (await deps.storage.get<string[]>(OPEN_KERNEL_APPS_STORAGE_KEY)) ?? []
	}

	async function open(id: string): Promise<void> {
		const ids = await openIds()
		if (!ids.includes(id)) await deps.storage.put(OPEN_KERNEL_APPS_STORAGE_KEY, [...ids, id])
		deps.broadcast({ type: 'kernel_app_open', id })
	}

	async function close(id?: string): Promise<void> {
		const ids = await openIds()
		const target = id ?? ids[ids.length - 1]
		if (!target) return
		const next = ids.filter((x) => x !== target)
		if (next.length === 0) await deps.storage.delete(OPEN_KERNEL_APPS_STORAGE_KEY)
		else await deps.storage.put(OPEN_KERNEL_APPS_STORAGE_KEY, next)
		deps.broadcast({ type: 'kernel_app_close', id: target })
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
			// When the URL pins the manifest version, the byte stream is
			// immutable for that URL — browsers re-use the cached entry on
			// re-launch within the token's lifetime, and a version bump in
			// list() drives a fresh fetch via a different URL.
			if (version && installed.manifest.version && version === installed.manifest.version) {
				headers['cache-control'] = 'private, max-age=31536000, immutable'
			}
			return new Response(body, { headers })
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
		const k = await kernelReady()
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
			const result = await (await kernelReady()).dispatch(appId, request.action as Action)
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
		close: async (id?: string) => {
			await close(id)
		},
		current: async () => {
			const ids = await openIds()
			const lastId = ids[ids.length - 1]
			return lastId ? await inspect(lastId).catch(() => undefined) : undefined
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
		openIds,
		open,
		close,
		asset,
		acceptWebSocket,
		handleMessage
	}
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

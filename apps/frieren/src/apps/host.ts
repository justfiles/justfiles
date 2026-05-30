// Imperative lifecycle store for apps. The host React tree must NOT
// own the guest's mount node — when React reorders/unmounts a window for
// any reason (StrictMode, list reorder, parent re-render quirks), it would
// destroy the guest's DOM and wipe in-element state like canvas bitmaps.
//
// So: each app's wrapper <div> lives in this module-level Map, gets created
// once on open(), and is just appendChild'd into whichever React slot is
// currently presenting it. React detach/reattach doesn't destroy the canvas.
// True teardown only happens via close(), called from the launcher's
// explicit close/uninstall paths (mirroring VS Code's createWebviewPanel /
// panel.dispose model).

import type { Action, Kernel } from '@justfiles/app'
import type { Menu } from '@justfiles/app/browser'
import { terminateAppWorker } from './sandbox.worker'

interface Transport {
	invoke(action: Action): Promise<unknown>
	subscribe(onState: (state: unknown) => void): () => void
}

interface GuiInstance {
	update(state: unknown): Promise<void> | void
	unmount(): Promise<void> | void
}

interface GuiModule {
	gui: {
		mount(
			el: HTMLElement,
			state: unknown,
			ctx: { transport: Transport; setMenu(menu: Menu | null): void }
		): GuiInstance
	}
}

type ServerFrame =
	| { type: 'state'; state: unknown }
	| { type: 'result'; id: string; result: unknown }
	| { type: 'error'; id?: string; message: string }

interface Stage {
	id: string
	wrapper: HTMLDivElement
	mountEl: HTMLDivElement
	errorEl: HTMLDivElement
	socket?: WebSocket
	unsubscribe?: () => void
	instance?: GuiInstance
	menu?: Menu
	local?: boolean
	cancelled: boolean
	outbox: string[]
	pending: Map<string, (frame: { result?: unknown; error?: string }) => void>
	subscribers: Set<(state: unknown) => void>
	nextId: number
}

export interface OpenOptions {
	guiUrl?: string
	getToken: () => Promise<string | null>
	// When present, the app runs in the browser kernel (local execution); its
	// presence is the per-app flag. Absent → server kernel over the WS.
	localKernel?: () => Promise<Kernel>
}

const stages = new Map<string, Stage>()

// Universal-menubar channel. Each stage's GUI publishes its current menus via
// the `setMenu` injected into mount; the shell reads the *focused* stage's menu
// and re-renders when any stage republishes (state change) or focus moves.
const menuSubscribers = new Set<() => void>()

function notifyMenus(): void {
	for (const fn of [...menuSubscribers]) fn()
}

export function subscribeMenus(fn: () => void): () => void {
	menuSubscribers.add(fn)
	return () => {
		menuSubscribers.delete(fn)
	}
}

export function menuOf(id: string): Menu | null {
	return stages.get(id)?.menu ?? null
}

export function open(id: string, opts: OpenOptions): void {
	if (stages.has(id)) return
	const stage = createStage(id)
	stages.set(id, stage)
	void boot(stage, opts)
}

export function close(id: string): void {
	const stage = stages.get(id)
	if (!stage) return
	stage.cancelled = true
	// Defer the GUI's root.unmount() to a microtask. The GUI lives in its
	// own React root; unmounting it synchronously from inside a commit
	// phase trips "Attempted to synchronously unmount a root while React
	// was already rendering" and leaves the DOM in an inconsistent state.
	const inst = stage.instance
	if (inst) queueMicrotask(() => void inst.unmount())
	stage.socket?.close()
	stage.unsubscribe?.()
	// Last window of a local app closed — reclaim its Web Worker.
	if (stage.local) terminateAppWorker(id)
	stage.wrapper.remove()
	stages.delete(id)
	// The focused app may have just closed — drop its menu from the bar.
	notifyMenus()
}

// Tear down every open stage. Called on OS teardown (sign-out / user switch /
// provider unmount) so a previous session's app GUIs don't leak into the next.
export function closeAll(): void {
	for (const id of [...stages.keys()]) close(id)
}

export function wrapperOf(id: string): HTMLDivElement | undefined {
	return stages.get(id)?.wrapper
}

function createStage(id: string): Stage {
	const wrapper = document.createElement('div')
	wrapper.dataset.appId = id
	wrapper.className = 'relative h-full w-full'

	const mountEl = document.createElement('div')
	mountEl.className = 'h-full w-full overflow-hidden'
	mountEl.style.contain = 'paint'
	wrapper.appendChild(mountEl)

	const errorEl = document.createElement('div')
	errorEl.className =
		'absolute inset-0 flex items-center justify-center bg-slate-950/95 p-6 text-center text-sm text-rose-200'
	errorEl.style.display = 'none'
	wrapper.appendChild(errorEl)

	return {
		id,
		wrapper,
		mountEl,
		errorEl,
		cancelled: false,
		outbox: [],
		pending: new Map(),
		subscribers: new Set(),
		nextId: 0
	}
}

function setError(stage: Stage, message: string | null): void {
	if (message) {
		stage.errorEl.textContent = `Failed to load app: ${message}`
		stage.errorEl.style.display = 'flex'
	} else {
		stage.errorEl.textContent = ''
		stage.errorEl.style.display = 'none'
	}
}

function pushState(stage: Stage, state: unknown): void {
	if (stage.cancelled) return
	void stage.instance?.update(state)
	for (const fn of stage.subscribers) fn(state)
}

// Both transports expose the same subscribe channel — extra consumers (beyond
// the GUI's own `update`) registering for state pushes.
function subscribeState(stage: Stage): Transport['subscribe'] {
	return (onState) => {
		stage.subscribers.add(onState)
		return () => {
			stage.subscribers.delete(onState)
		}
	}
}

// Mount the app's GUI into its stage with `null` state, so it can render its
// own bootstrap UI (spinner, empty list) before the transport delivers the
// first snapshot. Shared by both boot paths.
function mountGui(stage: Stage, mod: GuiModule, transport: Transport): void {
	stage.instance = mod.gui.mount(stage.mountEl, null, {
		transport,
		setMenu: (menu) => {
			if (stage.cancelled) return
			stage.menu = menu ?? undefined
			notifyMenus()
		}
	})
}

async function boot(stage: Stage, opts: OpenOptions): Promise<void> {
	try {
		if (opts.localKernel) await bootLocal(stage, opts.localKernel)
		else await bootRemote(stage, opts)
	} catch (e) {
		if (!stage.cancelled) setError(stage, e instanceof Error ? e.message : String(e))
	}
}

// Browser-kernel path: dispatch locally, load gui.js from the synced volume
// (no token, works offline once hydrated), push state via kernel events.
async function bootLocal(stage: Stage, getKernel: () => Promise<Kernel>): Promise<void> {
	const kernel = await getKernel()
	if (stage.cancelled) return
	stage.local = true

	const installed = await kernel.app(stage.id)
	const guiPath = installed.manifest.gui
	if (!guiPath) {
		setError(stage, 'app has no gui')
		return
	}
	const code = new TextDecoder().decode(await installed.read(guiPath))
	const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))
	let mod: GuiModule
	try {
		mod = (await import(/* @vite-ignore */ url)) as GuiModule
	} finally {
		URL.revokeObjectURL(url)
	}
	if (stage.cancelled) return

	// Hold the GUI's mount-time dispatches until the initial snapshot is
	// pushed, so a query/handler fired from mount can't have its result
	// clobbered by the snapshot that lands after it.
	let openGate = () => {}
	const gate = new Promise<void>((resolve) => {
		openGate = resolve
	})
	const transport: Transport = {
		invoke: async (action) => {
			await gate
			return kernel.dispatch(stage.id, action)
		},
		subscribe: subscribeState(stage)
	}

	mountGui(stage, mod, transport)
	// Snapshot first, then subscribe for subsequent local dispatches, then
	// release the queued mount-time dispatches. In 2a this browser is the only
	// writer to the local kernel, so no agent update can race the snapshot.
	const snapshot = await kernel.state(stage.id).catch(() => undefined)
	if (stage.cancelled) return
	pushState(stage, snapshot ?? null)
	stage.unsubscribe = kernel.subscribe((event) => {
		if (event.type === 'app.update' && event.appId === stage.id) pushState(stage, event.state)
	})
	openGate()
}

// Server-kernel path: dispatch and state ride a per-app WebSocket; gui.js is
// imported over HTTP (token in URL, since Clerk cookie auth 401s a non-document
// fetch). Vite must not analyse the dynamic specifier.
async function bootRemote(stage: Stage, opts: OpenOptions): Promise<void> {
	const token = await opts.getToken().catch(() => null)
	if (stage.cancelled) return
	if (!token) {
		setError(stage, 'not authenticated')
		return
	}

	// GUI may dispatch from its mount effect before the socket reaches OPEN;
	// queue those frames and flush on open, else the first dispatch races the
	// handshake and fails with `no_connection`.
	const send = (frame: string) => {
		const ws = stage.socket
		if (ws && ws.readyState === ws.OPEN) ws.send(frame)
		else stage.outbox.push(frame)
	}
	const transport: Transport = {
		invoke: (action) =>
			new Promise((resolve, reject) => {
				const reqId = String(stage.nextId++)
				stage.pending.set(reqId, (frame) => {
					if (frame.error !== undefined) reject(new Error(frame.error))
					else resolve(frame.result)
				})
				send(JSON.stringify({ id: reqId, action }))
			}),
		subscribe: subscribeState(stage)
	}

	// The guiUrl carries `?v=<manifest.version>` when known, so the asset
	// handler can serve it with immutable cache headers.
	const base = opts.guiUrl ?? `/api/apps/${stage.id}/gui.js`
	const sep = base.includes('?') ? '&' : '?'
	const mod = (await import(
		/* @vite-ignore */ `${base}${sep}token=${encodeURIComponent(token)}`
	)) as GuiModule
	if (stage.cancelled) return

	mountGui(stage, mod, transport)

	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	const ws = new WebSocket(
		`${protocol}//${window.location.host}/api/apps/${stage.id}/ws?token=${encodeURIComponent(token)}`
	)
	stage.socket = ws

	ws.onopen = () => {
		while (stage.outbox.length > 0) ws.send(stage.outbox.shift() as string)
	}
	ws.onmessage = (event) => {
		let frame: ServerFrame
		try {
			frame = JSON.parse(event.data)
		} catch {
			return
		}
		if (frame.type === 'state') {
			pushState(stage, frame.state)
			return
		}
		if (frame.type === 'result') {
			const resolver = stage.pending.get(frame.id)
			if (resolver) {
				stage.pending.delete(frame.id)
				resolver({ result: frame.result })
			}
			return
		}
		if (frame.type === 'error') {
			if (frame.id !== undefined) {
				const resolver = stage.pending.get(frame.id)
				if (resolver) {
					stage.pending.delete(frame.id)
					resolver({ error: frame.message })
				}
			} else if (!stage.cancelled) {
				setError(stage, frame.message)
			}
		}
	}
	ws.onerror = () => {
		if (!stage.cancelled) setError(stage, 'connection error')
	}
	ws.onclose = () => {
		for (const [, resolve] of stage.pending) resolve({ error: 'connection_closed' })
		stage.pending.clear()
		stage.outbox.length = 0
	}
}

// Imperative lifecycle store for kernel apps. The host React tree must NOT
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

interface Transport {
	invoke(action: { type: string; params: unknown }): Promise<unknown>
	subscribe(onState: (state: unknown) => void): () => void
}

interface GuiInstance {
	update(state: unknown): Promise<void> | void
	unmount(): Promise<void> | void
}

interface GuiModule {
	gui: {
		mount(el: HTMLElement, state: unknown, ctx: { transport: Transport }): GuiInstance
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
	instance?: GuiInstance
	cancelled: boolean
	outbox: string[]
	pending: Map<string, (frame: { result?: unknown; error?: string }) => void>
	subscribers: Set<(state: unknown) => void>
	nextId: number
}

export interface OpenOptions {
	guiUrl?: string
	getToken: () => Promise<string | null>
}

const stages = new Map<string, Stage>()

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
	stage.wrapper.remove()
	stages.delete(id)
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

async function boot(stage: Stage, opts: OpenOptions): Promise<void> {
	// GUI mounts immediately (before WS opens) and is allowed to dispatch
	// from its mount effect. Queue those frames here and flush once the
	// socket reaches OPEN; without this, the first dispatch races the
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
		subscribe: (onState) => {
			stage.subscribers.add(onState)
			return () => {
				stage.subscribers.delete(onState)
			}
		}
	}

	try {
		const token = await opts.getToken().catch(() => null)
		if (stage.cancelled) return
		if (!token) {
			setError(stage, 'not authenticated')
			return
		}

		// Dynamic import resolves the kernel app's gui.js through the
		// per-user DO route (Volume-backed bytes). Token rides the URL
		// for the same reason the WS does — Clerk cookie auth 401s a
		// non-document fetch. Vite must not analyse this specifier.
		// The guiUrl carries `?v=<manifest.version>` when known, so
		// the asset handler can serve it with immutable cache headers.
		const base = opts.guiUrl ?? `/api/kernel/${stage.id}/gui.js`
		const sep = base.includes('?') ? '&' : '?'
		const mod = (await import(
			/* @vite-ignore */ `${base}${sep}token=${encodeURIComponent(token)}`
		)) as GuiModule
		if (stage.cancelled) return

		// Mount immediately with `null` so the app's GUI can render its
		// own bootstrap UI (loading spinner, empty list, etc.) while the
		// WS handshake completes. Without this, the user stares at a
		// blank frame for the round-trip to the DO.
		stage.instance = mod.gui.mount(stage.mountEl, null, { transport })

		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
		const ws = new WebSocket(
			`${protocol}//${window.location.host}/api/kernel/${stage.id}/ws?token=${encodeURIComponent(token)}`
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
				if (stage.cancelled) return
				void stage.instance?.update(frame.state)
				for (const fn of stage.subscribers) fn(frame.state)
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
	} catch (e) {
		if (!stage.cancelled) setError(stage, e instanceof Error ? e.message : String(e))
	}
}

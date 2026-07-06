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

import type { Kernel } from '@justfiles/app'
import { REMOTE_SOURCE } from '@justfiles/fs'
import type { Volume } from '../fs'
import { ensureCapabilitySocket } from './capabilities.client'
import { bootGui, type GuiInstance, guiHost } from './gui-channel'
import { terminateAppWorker } from './sandbox.worker'

interface Stage {
	id: string
	wrapper: HTMLDivElement
	mountEl: HTMLDivElement
	errorEl: HTMLDivElement
	unsubscribe?: () => void
	unwatch?: () => void
	instance?: GuiInstance
	port?: MessagePort
	local?: boolean
	cancelled: boolean
}

export interface OpenOptions {
	getToken: () => Promise<string | null>
	// The browser kernel: the app dispatches locally against the synced volume.
	localKernel: () => Promise<Kernel>
	// The synced volume, for watching this app's state file so the open GUI
	// re-renders when the agent (server kernel) writes state that syncs down.
	volume: Promise<Volume>
}

const stages = new Map<string, Stage>()

// Installed-app catalog channel. `devkit.install` writes a new app to
// `/applications` through its own kernel instance, so the OS launcher (which
// caches the list) must be told to re-list. The OS subscribes once in
// OSProvider; the capability calls `notifyCatalog()` after a successful install.
const catalogSubscribers = new Set<() => void>()

export function notifyCatalog(): void {
	for (const fn of [...catalogSubscribers]) fn()
}

export function subscribeCatalog(fn: () => void): () => void {
	catalogSubscribers.add(fn)
	return () => {
		catalogSubscribers.delete(fn)
	}
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
	stage.unsubscribe?.()
	stage.unwatch?.()
	stage.port?.close()
	// Last window of a local app closed — reclaim its Web Worker.
	if (stage.local) terminateAppWorker(id)
	stage.wrapper.remove()
	stages.delete(id)
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
		cancelled: false
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

// Push authoritative state to the guest GUI over its port. The guest re-renders
// on the `state` message; the host never touches the guest's mount node.

// Browser-kernel path: dispatch locally, load gui.js from the synced volume
// (no token, works offline once hydrated), push state via kernel events.
async function boot(stage: Stage, opts: OpenOptions): Promise<void> {
	try {
		await bootLocal(stage, opts)
	} catch (e) {
		if (!stage.cancelled) setError(stage, e instanceof Error ? e.message : String(e))
	}
}

async function bootLocal(stage: Stage, opts: OpenOptions): Promise<void> {
	const kernel = await opts.localKernel()
	if (stage.cancelled) return
	stage.local = true

	const installed = await kernel.app(stage.id)
	const guiPath = installed.manifest.gui
	if (!guiPath) {
		setError(stage, 'app has no gui')
		return
	}
	const code = new TextDecoder().decode(await installed.read(guiPath))
	if (stage.cancelled) return

	// Hold the GUI's mount-time dispatches until the initial snapshot is mounted
	// and the state subscriptions are live, so a mount-time dispatch's `app.update`
	// can't be missed (the GUI re-renders from state pushes, not action returns).
	let openGate = () => {}
	const gate = new Promise<void>((resolve) => {
		openGate = resolve
	})

	// The GUI talks to the kernel only through this channel: the host holds
	// `port1` and dispatches; the guest holds `port2` and mounts. In Step 2 both
	// ports live in this realm — Step 3 moves `port2` into a sandboxed iframe.
	const { port1, port2 } = new MessageChannel()
	stage.port = port1
	const postState = guiHost(port1, async (action) => {
		await gate
		return kernel.dispatch(stage.id, action)
	})

	// Snapshot first, then mount/subscribe for subsequent local dispatches, then
	// release the queued mount-time dispatches. In 2a this browser is the only
	// writer to the local kernel, so no agent update can race the snapshot.
	// `state()` resolves to the reducer's initialState for a never-run app, so the
	// GUI always mounts on a non-null frame; a real failure throws to `boot`.
	const snapshot = await kernel.state(stage.id)
	if (stage.cancelled) return
	stage.instance = await bootGui({ el: stage.mountEl, port: port2, guiCode: code, state: snapshot })
	if (stage.cancelled) {
		void stage.instance.unmount()
		return
	}
	stage.unsubscribe = kernel.subscribe((event) => {
		if (event.type === 'app.update' && event.appId === stage.id) postState(event.state)
	})

	// Local dispatches push state via the kernel events above. The agent runs on
	// the SERVER kernel, so its writes never fire those events — they arrive as a
	// remote-sourced sync pull of /state/<id>.json. Watch that file and re-read
	// fresh state on a remote change so the open window reflects the agent's work.
	const vol = await opts.volume
	if (stage.cancelled) return
	stage.unwatch = await vol.watch(`/state/${stage.id}.json`, (event) => {
		if (event.source !== REMOTE_SOURCE || stage.cancelled) return
		void kernel
			.state(stage.id)
			.then((state) => {
				if (!stage.cancelled) postState(state ?? null)
			})
			.catch(() => {})
	})

	// Open the caps socket eagerly so the server's `dirty` push reaches this app
	// even if it never invokes a network capability (e.g. paint); pull-on-dirty
	// then lands the agent's writes at once via the watch above.
	ensureCapabilitySocket(opts.getToken)

	openGate()
}

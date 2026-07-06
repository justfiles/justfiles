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

import type { Kernel, Message } from '@justfiles/app'
import { REMOTE_SOURCE } from '@justfiles/fs'
import type { Volume } from '../fs'
import { ensureCapabilitySocket } from './capabilities.client'
import { terminateAppWorker } from './sandbox.worker'

interface Transport {
	invoke(message: Message): Promise<unknown>
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

interface Stage {
	id: string
	wrapper: HTMLDivElement
	mountEl: HTMLDivElement
	errorEl: HTMLDivElement
	unsubscribe?: () => void
	unwatch?: () => void
	instance?: GuiInstance
	local?: boolean
	cancelled: boolean
	subscribers: Set<(state: unknown) => void>
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
		cancelled: false,
		subscribers: new Set()
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

// Mount the app's GUI into its stage with the kernel snapshot. For a never-run
// app, `kernel.state()` resolves to the reducer's initial state.
function mountGui(stage: Stage, mod: GuiModule, transport: Transport, state: unknown): void {
	stage.instance = mod.gui.mount(stage.mountEl, state, { transport })
}

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

	// Snapshot first, then mount/subscribe for subsequent local dispatches, then
	// release the queued mount-time dispatches. In 2a this browser is the only
	// writer to the local kernel, so no agent update can race the snapshot.
	// `state()` resolves to the reducer's initialState for a never-run app, so the
	// GUI always mounts on a non-null frame; a real failure throws to `boot`.
	const snapshot = await kernel.state(stage.id)
	if (stage.cancelled) return
	mountGui(stage, mod, transport, snapshot)
	stage.unsubscribe = kernel.subscribe((event) => {
		if (event.type === 'app.update' && event.appId === stage.id) pushState(stage, event.state)
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
				if (!stage.cancelled) pushState(stage, state ?? null)
			})
			.catch(() => {})
	})

	// Open the caps socket eagerly so the server's `dirty` push reaches this app
	// even if it never invokes a network capability (e.g. paint); pull-on-dirty
	// then lands the agent's writes at once via the watch above.
	ensureCapabilitySocket(opts.getToken)

	openGate()
}

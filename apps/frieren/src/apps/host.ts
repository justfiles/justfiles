// Imperative lifecycle store for apps. The host React tree must NOT own the
// guest's mount node — when React reorders/unmounts a window for any reason
// (StrictMode, list reorder, parent re-render quirks), it would destroy the
// guest's surface and wipe in-element state like canvas bitmaps.
//
// So: each app's wrapper <div> lives in this module-level Map, gets created once
// on open(), and is just appendChild'd into whichever React slot is currently
// presenting it. React detach/reattach doesn't destroy an in-realm mount's DOM.
// A sandboxed iframe *is* discarded on detach, so its guest re-boots from the
// persisted snapshot on every load. True teardown only happens via close().

import type { Kernel } from '@justfiles/app'
import { REMOTE_SOURCE } from '@justfiles/fs'
import { DEVKIT_ALLOWLIST } from '../../shared/devkit.allowlist.ts'
import type { Volume } from '../fs'
import { ensureCapabilitySocket } from './capabilities.client'
import {
	bootGui,
	FRAME_SRCDOC,
	type GuiInstance,
	guiHost,
	hostTheme,
	readHostStyles,
	readVendor
} from './gui-channel'
import { terminateAppWorker } from './sandbox.worker'

interface Stage {
	id: string
	wrapper: HTMLDivElement
	errorEl: HTMLDivElement
	frame?: HTMLIFrameElement
	instance?: GuiInstance
	unsubscribe?: () => void
	unwatch?: () => void
	unlisten?: () => void
	port?: MessagePort
	postState?: (state: unknown) => void
	boot?: () => void
	local?: boolean
	cancelled: boolean
}

// Trusted, first-party apps mount in-realm: shared React, native styling, and
// host-DOM access (devkit's live preview reparents a stage into app-code's own
// slot, which must be in this document). Everything else runs in the isolation
// iframe. Built-ins are the `app.frieren.*` family plus the devkit-allowlisted
// apps (`app.code`); a third-party install falls through to the sandbox.
function sandboxed(id: string): boolean {
	return !(id.startsWith('app.frieren.') || DEVKIT_ALLOWLIST.has(id))
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
	// An in-realm GUI owns a React root; defer its unmount to a microtask so it
	// never runs synchronously inside a host commit phase. An iframe guest needs
	// no unmount — removing the wrapper discards its browsing context.
	const inst = stage.instance
	if (inst) queueMicrotask(() => void inst.unmount())
	stage.unsubscribe?.()
	stage.unwatch?.()
	stage.unlisten?.()
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

	const errorEl = document.createElement('div')
	errorEl.className =
		'absolute inset-0 flex items-center justify-center bg-slate-950/95 p-6 text-center text-sm text-rose-200'
	errorEl.style.display = 'none'
	wrapper.appendChild(errorEl)

	return { id, wrapper, errorEl, cancelled: false }
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
	const guiCode = new TextDecoder().decode(await installed.read(guiPath))
	if (stage.cancelled) return

	// State pushes go to whichever port the current guest holds. Registered before
	// mount so a mount-time dispatch's `app.update` is never missed (the GUI
	// re-renders from state pushes, not action returns).
	stage.unsubscribe = kernel.subscribe((event) => {
		if (event.type === 'app.update' && event.appId === stage.id) stage.postState?.(event.state)
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
				if (!stage.cancelled) stage.postState?.(state ?? null)
			})
			.catch(() => {})
	})

	// Open the caps socket eagerly so the server's `dirty` push reaches this app
	// even if it never invokes a network capability (e.g. paint); pull-on-dirty
	// then lands the agent's writes at once via the watch above.
	ensureCapabilitySocket(opts.getToken)

	if (sandboxed(stage.id)) mountInFrame(stage, kernel, guiCode, await readVendor())
	else await mountInRealm(stage, kernel, guiCode)
}

// Trusted path: mount the GUI directly in the host document — shared React, no
// cold start, full host-DOM access. The mount node is a plain <div> that
// survives React detach/reattach with its in-element state (canvas) intact.
async function mountInRealm(stage: Stage, kernel: Kernel, guiCode: string): Promise<void> {
	const el = document.createElement('div')
	el.className = 'h-full w-full overflow-hidden'
	el.style.contain = 'paint'
	stage.wrapper.insertBefore(el, stage.errorEl)

	const { port1, port2 } = new MessageChannel()
	stage.port = port1
	stage.postState = guiHost(port1, (action) => kernel.dispatch(stage.id, action))

	const snapshot = await kernel.state(stage.id)
	if (stage.cancelled) return
	stage.instance = await bootGui({ el, port: port2, guiCode, state: snapshot })
	if (stage.cancelled) void stage.instance.unmount()
}

// Untrusted path: mount the GUI in an opaque-origin `allow-scripts` iframe — no
// cookies, no host DOM, no token; its only authority is the port. Detaching the
// iframe (window minimize) discards its realm, so (re)boot from the current
// snapshot on every load. A fresh channel per boot: the host keeps `port1` and
// dispatches; the frame receives `port2` and mounts.
function mountInFrame(
	stage: Stage,
	kernel: Kernel,
	guiCode: string,
	vendor: Record<string, string>
): void {
	const styles = readHostStyles()
	const theme = hostTheme()
	const frame = document.createElement('iframe')
	frame.className = 'h-full w-full'
	frame.style.border = '0'
	frame.setAttribute('sandbox', 'allow-scripts')
	frame.srcdoc = FRAME_SRCDOC
	stage.frame = frame

	stage.boot = () => {
		void (async () => {
			try {
				const snapshot = await kernel.state(stage.id)
				if (stage.cancelled) return
				stage.port?.close()
				const { port1, port2 } = new MessageChannel()
				stage.port = port1
				stage.postState = guiHost(port1, (action) => kernel.dispatch(stage.id, action))
				frame.contentWindow?.postMessage(
					{ type: 'boot', guiCode, vendor, styles, theme, state: snapshot },
					'*',
					[port2]
				)
			} catch (e) {
				if (!stage.cancelled) setError(stage, e instanceof Error ? e.message : String(e))
			}
		})()
	}
	frame.addEventListener('load', () => stage.boot?.())

	// A guest boot failure (gui import/mount inside the frame) reports back here.
	const onMessage = (e: MessageEvent) => {
		if (e.source === frame.contentWindow && (e.data as { type?: string })?.type === 'error')
			setError(stage, String((e.data as { message?: unknown }).message))
	}
	window.addEventListener('message', onMessage)
	stage.unlisten = () => window.removeEventListener('message', onMessage)

	// The load listener (set above) fires boot once the frame's srcdoc loads —
	// now if the wrapper is already in the document, or on attach otherwise.
	stage.wrapper.insertBefore(frame, stage.errorEl)
}

// Imperative lifecycle store for apps. The host React tree must NOT own the
// guest's mount node — when React reorders/unmounts a window for any reason
// (StrictMode, list reorder, parent re-render quirks), it would destroy the
// guest's surface. So each app's wrapper <div> lives in this module-level Map,
// created once on open(), and is appendChild'd into whichever React slot is
// presenting it. Every GUI runs in a sandboxed iframe inside that wrapper;
// detaching the iframe (window minimize) discards its realm, so the guest
// re-boots from the persisted snapshot on every load. True teardown is close().

import type { Kernel } from '@justfiles/app'
import { mountAppFrame } from '@justfiles/app/iframe'
import { REMOTE_SOURCE } from '@justfiles/fs'
import type { Volume } from '../fs'
import { closeAllDialogs, closeDialog, openDialog } from './dialogs'
import { teardownReducerFrame, terminateAppWorker } from './sandbox.worker'

interface Stage {
	id: string
	wrapper: HTMLDivElement
	gui?: ReturnType<typeof mountAppFrame>
	errorEl: HTMLDivElement
	unsubscribe?: () => void
	unwatch?: () => void
	unwatchBundle?: () => void
	postState?: (state: unknown) => void
	local?: boolean
	cancelled: boolean
}

export interface OpenOptions {
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

// Window-request channel. A host capability (devkit's live preview) creates a
// stage with its own scoped kernel, then asks the OS shell to frame it as a
// window. The shell subscribes once in OSProvider and dispatches the matching
// window action; the capability stays out of OS state.
export type WindowRequest =
	| { type: 'open'; id: string; title: string }
	| { type: 'close'; id: string }
	| { type: 'focus'; id: string }
const windowSubscribers = new Set<(req: WindowRequest) => void>()

export function requestWindow(req: WindowRequest): void {
	for (const fn of [...windowSubscribers]) fn(req)
}

export function subscribeWindows(fn: (req: WindowRequest) => void): () => void {
	windowSubscribers.add(fn)
	return () => {
		windowSubscribers.delete(fn)
	}
}

// Stage-recreation channel. A viewport re-attaches its wrapper whenever a stage
// is (re)opened for its id — e.g. the devkit preview restarts on ⟳ Run, which
// closes and reopens the same id without unmounting the window presenting it.
const stageSubscribers = new Map<string, Set<() => void>>()

function notifyStage(id: string): void {
	for (const fn of stageSubscribers.get(id) ?? []) fn()
}

export function subscribeStage(id: string, fn: () => void): () => void {
	let set = stageSubscribers.get(id)
	if (!set) {
		set = new Set()
		stageSubscribers.set(id, set)
	}
	set.add(fn)
	return () => {
		set.delete(fn)
		if (set.size === 0) stageSubscribers.delete(id)
	}
}

export function open(id: string, opts: OpenOptions): void {
	if (stages.has(id)) return
	const stage = createStage(id)
	stages.set(id, stage)
	// A viewport already presenting this id (e.g. a preview window across a
	// ⟳ Run) re-attaches the fresh wrapper.
	notifyStage(id)
	void boot(stage, opts)
}

export function close(id: string): void {
	const stage = stages.get(id)
	if (!stage) return
	closeDialog(id)
	stage.cancelled = true
	stage.unsubscribe?.()
	stage.unwatch?.()
	stage.unwatchBundle?.()
	stage.gui?.dispose()
	// Last window of a local app closed — reclaim its Web Worker. Removing the
	// wrapper discards the iframe's browsing context, tearing down the GUI realm.
	if (stage.local) terminateAppWorker(id)
	stage.wrapper.remove()
	stages.delete(id)
}

// Tear down every open stage. Called on OS teardown (sign-out / user switch /
// provider unmount) so a previous session's app GUIs don't leak into the next.
// Also drops the shared reducer frame — the reducers a previous user's apps ran.
export function closeAll(): void {
	for (const id of [...stages.keys()]) close(id)
	closeAllDialogs()
	teardownReducerFrame()
}

export function wrapperOf(id: string): HTMLDivElement | undefined {
	return stages.get(id)?.wrapper
}

// Quiesce: swap a running app to its new bundle. Tear the stage down first
// (stops dispatches, drops the cached sandbox + GUI realm) so an old GUI never
// pairs with the new reducer, then reopen. A viewport re-attaches via notifyStage.
function reboot(id: string, opts: OpenOptions): void {
	close(id)
	open(id, opts)
}

function createStage(id: string): Stage {
	const wrapper = document.createElement('div')
	wrapper.dataset.appId = id
	wrapper.className = 'frn-stage'

	const errorEl = document.createElement('div')
	errorEl.className = 'frn-stage-error'
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

// Browser-kernel path: dispatch locally, load gui.js through the kernel (from the
// volume for a copied app, mounted from the release origin and cached for a hosted
// one — no token either way, and offline once the service worker has the release),
// push state via kernel events.
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

	const vol = await opts.volume
	if (stage.cancelled) return

	// Baseline for the bundle-swap watch at the tail of this function, taken BEFORE
	// the bundle is read. The watch can only be registered once the stage is wired,
	// so an install landing in between is missed either way — but a baseline that is
	// never NEWER than the code we booted keeps that recoverable: the next remote
	// manifest write still reads as a swap and reboots, even if it republishes the
	// same bytes. Taking it after would pin the baseline to a bundle the open GUI
	// isn't running, leaving it stale until some other install or a close/reopen.
	const manifestPath = `/applications/${stage.id}/manifest.json`
	const readManifest = (): Promise<string | null> =>
		vol.readFile(manifestPath).then(
			(bytes) => new TextDecoder().decode(bytes),
			() => null
		)
	let bundle = await readManifest()
	if (stage.cancelled) return

	const installed = await kernel.app(stage.id)
	const guiPath = installed.manifest.gui
	if (!guiPath) {
		setError(stage, 'app has no gui')
		return
	}
	const guiCode = new TextDecoder().decode(await installed.read(guiPath))
	if (stage.cancelled) return

	let current: unknown
	let updated = false
	stage.postState = (state) => {
		current = state
		updated = true
		stage.gui?.update(state)
	}

	// Register both state sources before boot can read its first snapshot. A local
	// dispatch pushes through the kernel. A server dispatch arrives as a remote
	// write and only needs the watch to tell this window to read again.
	stage.unsubscribe = kernel.subscribe((event) => {
		if (event.type === 'app.update' && event.appId === stage.id) stage.postState?.(event.state)
		else if (event.type === 'app.installed' && event.appId === stage.id) reboot(stage.id, opts)
	})
	const unwatchState = await vol.watch(`/state/${stage.id}.json`, (event) => {
		if (event.source !== REMOTE_SOURCE || stage.cancelled) return
		void kernel
			.state(stage.id)
			.then((state) => {
				if (!stage.cancelled) stage.postState?.(state ?? null)
			})
			.catch(() => {})
	})
	if (stage.cancelled) {
		unwatchState()
		return
	}
	stage.unwatch = unwatchState

	const snapshot = await kernel.state(stage.id)
	if (stage.cancelled) return
	stage.gui = mountAppFrame(stage.wrapper, guiCode, updated ? current : snapshot, {
		invoke: (action) => kernel.dispatch(stage.id, action),
		dialog: (request) => {
			requestWindow({ type: 'focus', id: stage.id })
			return openDialog(stage.id, request)
		},
		onError: (message) => setError(stage, message)
	})

	// Quiesce: a synced-down bundle change (REMOTE_SOURCE write to
	// /applications/<id>/*) must reboot the GUI. Watch the manifest — the atomic
	// tmp→rename install rebinds it. Filtering on REMOTE_SOURCE avoids a double
	// reboot with the `app.installed` path above (local installs carry no source).
	//
	// A wake is not a change. The watch fires on any remote write to the path, and a
	// write that lands the bytes the file already held is still a write: another
	// device reinstalling the same version republishes an identical manifest, and
	// sync applies it here. Rebooting on that discards the guest's realm — the
	// window goes blank and remounts from the snapshot — for a bundle that did not
	// move. So compare the bytes and reboot only on a real swap. The manifest is a
	// sound proxy for the whole bundle (it pins each mounted file's hash, and the
	// whole-app `hash` for a copied one), which is why it is the watched path. The
	// `bundle` baseline is read at the top, before the bundle itself — see there.
	stage.unwatchBundle = await vol.watch(manifestPath, (event) => {
		if (event.source !== REMOTE_SOURCE || stage.cancelled) return
		void readManifest().then((next) => {
			// An unreadable manifest is not a new bundle — there is nothing to boot into,
			// and the next write settles it either way.
			if (stage.cancelled || next === null || next === bundle) return
			bundle = next
			reboot(stage.id, opts)
		})
	})

	if (stage.cancelled) stage.unwatchBundle()
}

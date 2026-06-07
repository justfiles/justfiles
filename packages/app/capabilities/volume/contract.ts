// App-facing Volume capability contract. Scoped filesystem access; the host
// owns the path-to-storage mapping. The requested `scopes` decide which
// volume is bound: `'app'` (or missing) is the per-app chroot, `'system'`
// is the user's root volume, and a path-like scope binds a prefix chroot.

import type { Stream } from '../core.ts'

export interface VolumeEntry {
	path: string
	type: 'file' | 'dir'
}

export interface VolumeCapability {
	readFile(input: { path: string }): Promise<Uint8Array>
	writeFile(input: { path: string; data: Uint8Array }): Promise<void>
	mkdir(input: { path: string; recursive?: boolean }): Promise<void>
	scan(input: { path: string; recursive?: boolean }): Promise<VolumeEntry[]>
	exists(input: { path: string }): Promise<boolean>
	rm(input: { path: string; recursive?: boolean }): Promise<void>
	rename(input: { oldPath: string; newPath: string }): Promise<void>
}

// Payload delivered to a `volume.watch` subscriber. `source` is the tag the
// triggering write carried (sync tags remote-applied pulls; local user writes
// carry none), so an app can ignore its own writes.
export interface WatchEvent {
	source?: string
}

// Streams the volume can drive into a subscribing app (Part D). `watch` is a
// SINGLE-PATH watch: it fires when the file at `path` is itself changed
// (content/metadata) or created/removed/renamed. It is NOT recursive — writes
// to children of a watched directory do not fire, so watch a concrete file
// (e.g. the open document), not a folder. The app declares it via
// `subscriptions(state)` and folds events with `t.fromEvent('volume', 'watch')`.
export interface VolumeStreams {
	watch(input: { path: string }): Stream<WatchEvent>
}

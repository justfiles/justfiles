// App-facing Volume capability contract. Scoped filesystem access; the host
// owns the path-to-storage mapping. The requested `scopes` decide which
// volume is bound: `'app'` (or missing) is the per-app chroot, `'system'`
// is the user's root volume, and a path-like scope binds a prefix chroot.

import type { Volume } from '@justfiles/fs'
import type { Stream } from '../core.ts'

export interface VolumeEntry {
	path: string
	type: 'file' | 'dir'
}

// The capability surface IS the host filesystem interface — reused verbatim, not
// re-declared. Multi-arg and optional-arg signatures flow straight through the
// capability seam now (`writeFile(path, data)`, `mkdir(path, opts?)`,
// `setXattr(path, name, value)`, …). The two methods Volume models with a
// CALLBACK are the exceptions, since a function cannot cross the seam:
//   - `scan(path, visitor)` → re-expressed as a one-shot that RETURNS the listing
//   - `watch(path, listener)` → a `Stream` (see `VolumeStreams` below)
// Note: `stat`/`lstat`/`utimes` carry `bigint` and reads carry `Uint8Array`,
// neither of which survives a JSON wire — so volume binds as a LOCAL capability.
export type VolumeCapability = Omit<Volume, 'watch' | 'scan'> & {
	scan(input: { path: string; recursive?: boolean }): Promise<VolumeEntry[]>
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

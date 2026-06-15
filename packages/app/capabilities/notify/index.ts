import { defineCapability } from '../core.ts'
import type { Notification } from './types.ts'

export type { Channel, Notification, Route } from './types.ts'

// What an app passes to `notify`: everything but `source`, which the kernel stamps
// from the calling app's trusted identity (apps can't spoof another's source).
export type NotifyInput = Omit<Notification, 'source'>

export interface NotifyCapability {
	notify(input: NotifyInput): void
}

// The `notify` capability. An app emits a Notification; the host projects it onto
// its platform channel. Declared with no scope — emitting is unprivileged, and the
// kernel-stamped `source` is the only trust the channel needs.
export const notify = defineCapability<'notify', NotifyCapability>('notify')

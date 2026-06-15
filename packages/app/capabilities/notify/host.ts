import { implementCapability } from '../implement.ts'
import type { Capability } from '../types.ts'
import { notify } from './index.ts'
import type { Channel } from './types.ts'

// The host implementation of the `notify` capability. It stamps `source = appId`
// (the kernel-attached, trusted identity — never what the isolate claims) onto the
// app's notification and hands it to the host's `channel`. The channel is the
// per-host convergence point (quay → launcher sockets → UNUserNotificationCenter;
// frieren → web push / toast); everything portable lives above it.
export function notifyHost(channel: Channel): Capability {
	return implementCapability(notify, {
		notify: (ctx, input) => channel({ ...input, source: ctx.appId })
	})
}

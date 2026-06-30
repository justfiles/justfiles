import type { AppManifest } from '@justfiles/app'
import type { Notification } from '@justfiles/app/capabilities/notify'

/** Messages the daemon sends to a `/system` WebSocket client. */
export type ServerMessage =
	| { type: 'apps'; apps: AppManifest[] }
	| { type: 'hello'; message: string; time: string; uptime: number }
	| { type: 'error'; message: string }
	// A `notify`-capability or agent notification fanned out to every launcher; the
	// native sink (CatalogClient) projects it onto the OS banner.
	| { type: 'notification'; notification: Notification }

import type { AppManifest } from '@justfiles/app'

/** Messages the daemon sends to a `/system` WebSocket client. */
export type ServerMessage =
	| { type: 'apps'; apps: AppManifest[] }
	| { type: 'hello'; message: string; time: string; uptime: number }
	| { type: 'error'; message: string }

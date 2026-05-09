// Shared method contract between the client SDK (`window.app.*`) and the
// host worker. Every host RPC the iframe can call must appear here with
// its params and result types so both ends stay in sync.
//
// Adding a new host API is two steps:
//   1. Add an entry here.
//   2. Register a handler on the host (see `apps/frieren/worker/app-host.ts`).
// The transport (postMessage ↔ WebSocket ↔ DO) is method-agnostic.
//
// Binary payloads cross the wire as base64 strings; the SDK
// encodes/decodes so app authors deal in `Uint8Array`.

export interface HostMethods {
	'app.volume.readText': {
		params: { path: string }
		result: string
	}
	'app.volume.writeText': {
		params: { path: string; data: string }
		result: null
	}
	'app.volume.readFile': {
		params: { path: string }
		/** base64-encoded bytes */
		result: string
	}
	'app.volume.writeFile': {
		params: { path: string; bytes: string }
		result: null
	}
}

export type HostMethod = keyof HostMethods

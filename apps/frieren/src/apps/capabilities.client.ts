import {
	type Capabilities,
	type Capability,
	type CapabilityCall,
	CapabilityError,
	capabilityRegistry,
	fromWire,
	type WireError
} from '@justfiles/app/capabilities'
import type { Volume } from '@justfiles/fs'
import { DEVKIT_ALLOWLIST } from '../../shared/devkit.allowlist.ts'
import { volumeCapability } from '../../shared/volume.capability.ts'
import { flushActiveVolume } from '../fs.ts'

type GetToken = () => Promise<string | null>

type Frame =
	| { type: 'result'; id: string; result: unknown }
	| ({ type: 'error'; id?: string } & WireError)
	| { type: 'dirty'; appId?: string }

// The browser kernel's capability seam. `volume` and `devkit` run locally on this
// thread; everything else (ai/integrations) proxies to the server through the
// network fallback over ONE shared WebSocket. One wiring line replaces the old
// hand-written invoke/stream routers.
export function clientCapabilities(fs: Volume, getToken: GetToken): Capabilities {
	return capabilityRegistry(
		{ volume: volumeCapability(fs), devkit: devkitCapability(fs, getToken) },
		{ fallback: networkFallback(getToken) }
	)
}

// devkit runs locally (it compiles + mounts on this thread, never the server) and
// is grant-gated: only allowlisted apps may reach the impl. Its module — and the
// esbuild toolchain it pulls — is imported lazily on first use, so a session that
// never opens devkit pays nothing.
function devkitCapability(fs: Volume, getToken: GetToken): Capability {
	const reject = (method: string): Promise<never> =>
		Promise.reject(new CapabilityError('CAPABILITY_UNAVAILABLE', 'devkit', method))
	return {
		invoke: async (call) => {
			if (!DEVKIT_ALLOWLIST.has(call.appId)) return reject(call.method)
			const { invokeDevkit } = await import('./devkit.capability.ts')
			return invokeDevkit(fs, getToken, call)
		},
		subscribe: (call) => reject(call.method)
	}
}

// Everything not served locally proxies to the server. Offline guard mirrors the
// old bridge: a network capability with no connectivity fails fast as OFFLINE
// rather than hanging on a socket that can't open. Network streams aren't proxied
// yet (slice 10), so subscribe is unavailable here.
function networkFallback(getToken: GetToken): Capabilities {
	return {
		invoke: async (call) => {
			if (typeof navigator !== 'undefined' && !navigator.onLine)
				throw new CapabilityError('CAPABILITY_OFFLINE', call.capability, call.method)
			return (await connection(getToken)).invoke(call)
		},
		subscribe: async (call) => {
			throw new CapabilityError('CAPABILITY_UNAVAILABLE', call.capability, call.method)
		}
	}
}

// Drop the shared socket — called on OS teardown (sign-out / user switch) so a
// previous session's connection doesn't leak into the next.
export function resetCapabilitySocket(): void {
	const pending = shared
	shared = undefined
	void pending?.then((c) => c.close()).catch(() => {})
}

// Eagerly open the shared caps socket — normally it is lazy (opened on the
// first network capability), but the server's `dirty` push must also reach
// volume-only apps (e.g. paint) whose open windows never invoke a network
// capability. The host calls this on app open. Idempotent; failures self-heal
// on the next call or network capability.
export function ensureCapabilitySocket(getToken: GetToken): void {
	void connection(getToken).catch(() => {})
}

let shared: Promise<Connection> | undefined

function connection(getToken: GetToken): Promise<Connection> {
	if (!shared) {
		shared = open(getToken).catch((error) => {
			shared = undefined
			throw error
		})
	}
	return shared
}

interface Connection {
	invoke(call: CapabilityCall): Promise<unknown>
	close(): void
}

async function open(getToken: GetToken): Promise<Connection> {
	const token = await getToken()
	if (!token) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'capabilities', 'connect')
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	const ws = new WebSocket(
		`${protocol}//${window.location.host}/api/apps/_caps/ws?token=${encodeURIComponent(token)}`
	)
	const pending = new Map<
		string,
		{ call: CapabilityCall; resolve: (v: unknown) => void; reject: (e: Error) => void }
	>()
	let nextId = 0
	const dropped = () => new CapabilityError('CAPABILITY_UNAVAILABLE', 'capabilities', 'connect')

	// Connect phase: resolve on open, reject the lazy singleton on a failed
	// handshake so the next call reconnects.
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve()
		ws.onerror = () => reject(dropped())
	})

	// Steady state: a drop rejects every in-flight call and clears the
	// singleton; the next invoke opens a fresh socket.
	const fail = (error: Error) => {
		shared = undefined
		for (const [, p] of pending) p.reject(error)
		pending.clear()
	}
	ws.onmessage = (event) => {
		let frame: Frame
		try {
			frame = JSON.parse(event.data)
		} catch {
			return
		}
		if (frame.type === 'dirty') {
			flushActiveVolume()
			return
		}
		if (frame.id === undefined) return
		const p = pending.get(frame.id)
		if (!p) return
		pending.delete(frame.id)
		if (frame.type === 'error')
			p.reject(fromWire(frame, { capability: p.call.capability, method: p.call.method }))
		else p.resolve(frame.result)
	}
	ws.onclose = () => fail(dropped())
	ws.onerror = () => fail(dropped())

	return {
		invoke: (call) =>
			new Promise((resolve, reject) => {
				const id = String(nextId++)
				pending.set(id, { call, resolve, reject })
				ws.send(
					JSON.stringify({
						id,
						appId: call.appId,
						capability: call.capability,
						method: call.method,
						input: call.input
					})
				)
			}),
		close: () => ws.close()
	}
}

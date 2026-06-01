import type { Volume } from '@justfiles/fs'
import { capabilityError, fromWireError, type WireError } from '../../shared/capability-error.ts'
import { DEVKIT_ALLOWLIST } from '../../shared/devkit.allowlist.ts'
import { invokeVolume } from '../../shared/volume.capability.ts'
import { flushActiveVolume } from '../fs.ts'

type CapabilityInvocation = {
	capability: string
	method: string
	input: unknown
	scopes: readonly string[]
	actor?: string
	appId: string
}

type Frame =
	| { type: 'result'; id: string; result: unknown }
	| ({ type: 'error'; id?: string } & WireError)
	| { type: 'dirty'; appId?: string }

// The browser kernel runs `volume` locally; every other capability proxies to
// the server over ONE shared WebSocket (not one per call/app). The connection
// is lazy — opened on the first network capability — and self-heals: a drop
// rejects in-flight calls and the next call reconnects.
export async function invokeClientCapability(
	fs: Volume,
	getToken: () => Promise<string | null>,
	req: CapabilityInvocation
): Promise<unknown> {
	if (req.capability === 'volume') return invokeVolume(fs, req)
	// devkit also runs locally (it compiles + mounts on this thread, never the
	// server). Grant-gated: only allowlisted apps may reach the impl. Lazily
	// imported so its toolchain stays out of the initial bundle.
	if (req.capability === 'devkit') {
		if (!DEVKIT_ALLOWLIST.has(req.appId)) {
			throw capabilityError('CAPABILITY_UNAVAILABLE', 'devkit', req.method)
		}
		const { invokeDevkit } = await import('./devkit.capability.ts')
		return invokeDevkit(fs, getToken, req)
	}
	if (typeof navigator !== 'undefined' && !navigator.onLine) {
		throw capabilityError('CAPABILITY_OFFLINE', req.capability, req.method)
	}
	const conn = await connection(getToken)
	return conn.invoke(req)
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
export function ensureCapabilitySocket(getToken: () => Promise<string | null>): void {
	void connection(getToken).catch(() => {})
}

let shared: Promise<Connection> | undefined

function connection(getToken: () => Promise<string | null>): Promise<Connection> {
	if (!shared) {
		shared = open(getToken).catch((error) => {
			shared = undefined
			throw error
		})
	}
	return shared
}

interface Connection {
	invoke(req: CapabilityInvocation): Promise<unknown>
	close(): void
}

async function open(getToken: () => Promise<string | null>): Promise<Connection> {
	const token = await getToken()
	if (!token) throw capabilityError('CAPABILITY_UNAVAILABLE', 'capabilities', 'connect')
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	const ws = new WebSocket(
		`${protocol}//${window.location.host}/api/apps/_caps/ws?token=${encodeURIComponent(token)}`
	)
	const pending = new Map<
		string,
		{ req: CapabilityInvocation; resolve: (v: unknown) => void; reject: (e: Error) => void }
	>()
	let nextId = 0
	const dropped = () => capabilityError('CAPABILITY_UNAVAILABLE', 'capabilities', 'connect')

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
			p.reject(fromWireError(frame, { capability: p.req.capability, method: p.req.method }))
		else p.resolve(frame.result)
	}
	ws.onclose = () => fail(dropped())
	ws.onerror = () => fail(dropped())

	return {
		invoke: (req) =>
			new Promise((resolve, reject) => {
				const id = String(nextId++)
				pending.set(id, { req, resolve, reject })
				ws.send(
					JSON.stringify({
						id,
						appId: req.appId,
						capability: req.capability,
						method: req.method,
						input: req.input
					})
				)
			}),
		close: () => ws.close()
	}
}

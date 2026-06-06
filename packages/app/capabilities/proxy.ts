// A transparent remote `Capabilities` over an abstract `Channel`. A proxied
// capability is a `Capabilities` just like a local one, so the registry can use
// it as a `fallback` with no special-casing. This is today's `_caps` socket,
// generalized: correlated by id, over any transport (a Node server, a CF
// Worker, Electron-main) that can ship strings.
//
//   invoke    C→S {t:'call',id,…}   S→C {t:'ok',id,value} | {t:'err',id,…wire}
//   subscribe C→S {t:'sub',id,…}    S→C {t:'subok',id} ; {t:'event',id,event}(×N)
//                                       | {t:'err',id,…wire} (open failed)
//                C→S {t:'unsub',id}
//
// `subscribe` resolves only once the server confirms the open (`subok`), so a
// failed open rejects the caller instead of handing back a dead subscription.

import { CapabilityError, fromWire, toWire } from './error.ts'
import type { Capabilities, CapabilityCall, Emit, Unsubscribe } from './types.ts'

// The only thing a transport must provide.
export interface Channel {
	send(frame: string): void
	onMessage(cb: (frame: string) => void): void
	onClose(cb: () => void): void
}

type Frame = { t: string; id: number; [k: string]: unknown }

// Parse a wire frame, swallowing a malformed one (the transport may hand us
// arbitrary strings — e.g. an out-of-band `dirty` nudge, or a corrupt frame —
// and neither end should throw inside its message handler).
function parseFrame(raw: string): Frame | undefined {
	try {
		return JSON.parse(raw) as Frame
	} catch {
		return undefined
	}
}

// Scopes are NOT on the wire (the client cannot be trusted to claim them) — the
// serving kernel resolves them from its own copy of the app's declarations. At
// the package level the proxied capabilities are scope-free, so serve fills [].
const toCall = (f: Frame): CapabilityCall => ({
	appId: String(f.appId),
	capability: String(f.capability),
	method: String(f.method),
	input: f.input,
	scopes: []
})

// Provider side: answer `call` frames and keep `sub` streams alive (the
// returned `Unsubscribe` under its id) until `unsub` or the channel closes.
export function serveCapabilities(channel: Channel, local: Capabilities): void {
	const subs = new Map<number, Unsubscribe>()
	channel.onMessage((raw) => {
		const f = parseFrame(raw)
		if (!f) return // a malformed frame can't crash the serve loop
		if (f.t === 'call') void answer(channel, local, f)
		else if (f.t === 'sub') void open(channel, local, subs, f)
		else if (f.t === 'unsub') {
			subs.get(f.id)?.()
			subs.delete(f.id)
		}
	})
	channel.onClose(() => {
		for (const u of subs.values()) u()
		subs.clear()
	})
}

async function answer(channel: Channel, local: Capabilities, f: Frame): Promise<void> {
	try {
		channel.send(JSON.stringify({ t: 'ok', id: f.id, value: await local.invoke(toCall(f)) }))
	} catch (e) {
		channel.send(JSON.stringify({ t: 'err', id: f.id, ...toWire(e) }))
	}
}

async function open(
	channel: Channel,
	local: Capabilities,
	subs: Map<number, Unsubscribe>,
	f: Frame
): Promise<void> {
	// Mark the id live before awaiting so an `unsub` racing the open can cancel.
	subs.set(f.id, () => {})
	try {
		const unsubscribe = await local.subscribe(toCall(f), (event) =>
			channel.send(JSON.stringify({ t: 'event', id: f.id, event }))
		)
		if (subs.has(f.id)) {
			subs.set(f.id, unsubscribe)
			channel.send(JSON.stringify({ t: 'subok', id: f.id }))
		} else unsubscribe() // an `unsub` arrived while we were opening
	} catch (e) {
		subs.delete(f.id)
		channel.send(JSON.stringify({ t: 'err', id: f.id, ...toWire(e) }))
	}
}

type Pending = {
	resolve: (value: unknown) => void
	reject: (error: unknown) => void
	fallback: { capability: string; method: string }
}

// Caller side: a lazily-opened channel, a pending map (invoke) and a streams map
// (subscribe), both keyed by the same id space. A drop rejects everything in
// flight and clears the channel; the next call reopens.
export function proxyCapabilities(open: () => Promise<Channel>): Capabilities {
	let channel: Promise<Channel> | undefined
	let nextId = 0
	const pending = new Map<number, Pending>()
	// Subscribes awaiting the server's `subok`/`err` (open confirmation), keyed by
	// the same id space; cleared once the stream is live (moved to `streams`).
	const opening = new Map<number, Pending>()
	const streams = new Map<number, Emit>()

	const drop = () => {
		channel = undefined
		const offline = new CapabilityError('CAPABILITY_OFFLINE')
		for (const p of pending.values()) p.reject(offline)
		// A drop while opening rejects the subscribe; a live stream just goes quiet.
		// TODO: live streams don't self-heal on a drop — the kernel reconciler only
		// re-opens them on the next state touch. Fine until network streams ship.
		for (const o of opening.values()) o.reject(offline)
		pending.clear()
		opening.clear()
		streams.clear()
	}

	const dispatch = (f: Frame) => {
		if (f.t === 'event') return void streams.get(f.id)?.(f.event)
		if (f.t === 'subok') return void opening.get(f.id)?.resolve(undefined)
		const p = pending.get(f.id)
		if (p) {
			pending.delete(f.id)
			if (f.t === 'ok') p.resolve(f.value)
			else p.reject(fromWire(f as never, p.fallback))
			return
		}
		if (f.t !== 'err') return
		// An `err` against an opening subscribe rejects it; against an already-live
		// stream there is nothing left to reject, so just drop the slot.
		const o = opening.get(f.id)
		if (o) {
			opening.delete(f.id)
			streams.delete(f.id)
			o.reject(fromWire(f as never, o.fallback))
		} else streams.delete(f.id)
	}

	const connect = () => {
		if (!channel)
			channel = open()
				.then((ch) => {
					ch.onMessage((raw) => {
						const f = parseFrame(raw)
						if (f) dispatch(f)
					})
					ch.onClose(drop)
					return ch
				})
				.catch((e) => {
					// A failed open must not wedge the proxy: clear the cached promise
					// so the next call retries instead of re-awaiting the rejection.
					channel = undefined
					throw e
				})
		return channel
	}

	const frame = (t: string, id: number, call: CapabilityCall) =>
		JSON.stringify({
			t,
			id,
			appId: call.appId,
			capability: call.capability,
			method: call.method,
			input: call.input
		})

	return {
		invoke: async (call) => {
			const ch = await connect()
			const id = nextId++
			return new Promise((resolve, reject) => {
				pending.set(id, {
					resolve,
					reject,
					fallback: { capability: call.capability, method: call.method }
				})
				ch.send(frame('call', id, call))
			})
		},
		subscribe: async (call, emit) => {
			const ch = await connect()
			const id = nextId++
			// Register `emit` before sending so an event racing the `subok` still
			// routes; then wait for the open to be confirmed (or rejected).
			streams.set(id, emit)
			await new Promise<void>((resolve, reject) => {
				opening.set(id, {
					resolve: () => resolve(),
					reject,
					fallback: { capability: call.capability, method: call.method }
				})
				ch.send(frame('sub', id, call))
			}).finally(() => opening.delete(id))
			return () => {
				if (streams.delete(id)) ch.send(JSON.stringify({ t: 'unsub', id }))
			}
		}
	}
}

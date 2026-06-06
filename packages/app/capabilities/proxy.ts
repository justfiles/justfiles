// A transparent remote `Capabilities` over an abstract `Channel`. A proxied
// capability is a `Capabilities` just like a local one, so the registry can use
// it as a `fallback` with no special-casing. This is today's `_caps` socket,
// generalized: correlated by id, over any transport (a Node server, a CF
// Worker, Electron-main) that can ship strings.
//
//   invoke    C→S {t:'call',id,…}   S→C {t:'ok',id,value} | {t:'err',id,…wire}
//   subscribe C→S {t:'sub',id,…}    S→C {t:'event',id,event}(×N) | {t:'err',…}
//                C→S {t:'unsub',id}

import { CapabilityError, fromWire, toWire } from './error.ts'
import type { Capabilities, CapabilityCall, Emit, Unsubscribe } from './types.ts'

// The only thing a transport must provide.
export interface Channel {
	send(frame: string): void
	onMessage(cb: (frame: string) => void): void
	onClose(cb: () => void): void
}

type Frame = { t: string; id: number; [k: string]: unknown }

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
		const f = JSON.parse(raw) as Frame
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
		if (subs.has(f.id)) subs.set(f.id, unsubscribe)
		else unsubscribe() // an `unsub` arrived while we were opening
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
	const streams = new Map<number, Emit>()

	const drop = () => {
		channel = undefined
		const offline = new CapabilityError('CAPABILITY_OFFLINE')
		for (const p of pending.values()) p.reject(offline)
		pending.clear()
		streams.clear()
	}

	const dispatch = (f: Frame) => {
		if (f.t === 'event') return void streams.get(f.id)?.(f.event)
		const p = pending.get(f.id)
		if (p) {
			pending.delete(f.id)
			if (f.t === 'ok') p.resolve(f.value)
			else p.reject(fromWire(f as never, p.fallback))
		} else if (f.t === 'err') streams.delete(f.id) // a live stream failed
	}

	const connect = () => {
		if (!channel)
			channel = open()
				.then((ch) => {
					ch.onMessage((raw) => dispatch(JSON.parse(raw) as Frame))
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
			streams.set(id, emit)
			ch.send(frame('sub', id, call))
			return () => {
				if (streams.delete(id)) ch.send(JSON.stringify({ t: 'unsub', id }))
			}
		}
	}
}

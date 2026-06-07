// A linked pair of in-memory `RpcTransport`s — each side's `send` lands in the
// other's `receive` queue. Pull-based (Cap'n Web drives `receive()` in a loop):
// `receive()` resolves with the next queued frame or pends until one arrives;
// `abort()` rejects a pending receive so a session winds down. Test-only — NOT
// in the public barrel.

import type { RpcTransport } from 'capnweb'

interface Queue {
	push(msg: string): void
	pull(): Promise<string>
	fail(reason: unknown): void
}

function queue(): Queue {
	const msgs: string[] = []
	const waiters: Array<{ resolve: (m: string) => void; reject: (e: unknown) => void }> = []
	let failed: unknown
	return {
		push: (msg) => {
			const w = waiters.shift()
			if (w) w.resolve(msg)
			else msgs.push(msg)
		},
		pull: () =>
			new Promise<string>((resolve, reject) => {
				const msg = msgs.shift()
				if (msg !== undefined) resolve(msg)
				else if (failed) reject(failed)
				else waiters.push({ resolve, reject })
			}),
		fail: (reason) => {
			failed = reason
			for (const w of waiters) w.reject(reason)
			waiters.length = 0
		}
	}
}

export function transportPair(): [RpcTransport, RpcTransport] {
	const q: [Queue, Queue] = [queue(), queue()]
	const mk = (me: 0 | 1): RpcTransport => ({
		send: async (msg) => q[(me ^ 1) as 0 | 1].push(msg),
		receive: () => q[me].pull(),
		abort: (reason) => q[me].fail(reason)
	})
	return [mk(0), mk(1)]
}

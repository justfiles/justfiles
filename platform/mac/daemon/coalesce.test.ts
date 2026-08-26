import { expect, test } from 'vitest'
import { coalesce } from './coalesce'

// Drain all pending microtasks by crossing a macrotask boundary — deterministic,
// no counting of ticks (which makes coalescing tests flaky).
const flush = () => new Promise((resolve) => setTimeout(resolve))

// A gate the test opens by hand, so it controls exactly when a run finishes.
function gate(): { promise: Promise<void>; open: () => void } {
	let open!: () => void
	const promise = new Promise<void>((resolve) => {
		open = resolve
	})
	return { promise, open }
}

test('runs immediately on the leading edge', async () => {
	let runs = 0
	await coalesce(async () => void runs++)()
	expect(runs).toBe(1)
})

test('collapses a mid-flight burst and waits for the trailing run', async () => {
	const first = gate()
	const trailing = gate()
	let started = 0
	let finished = 0
	const trigger = coalesce(async () => {
		started++
		await (started === 1 ? first.promise : trailing.promise)
		finished++
	})

	const done = trigger()
	expect(trigger()).toBe(done)
	expect(trigger()).toBe(done)
	expect(started).toBe(1) // never a second concurrent run
	expect(finished).toBe(0)

	first.open()
	await flush()
	expect(started).toBe(2)
	expect(finished).toBe(1)

	let settled = false
	void done.then(() => {
		settled = true
	})
	await flush()
	expect(settled).toBe(false)

	trailing.open()
	await done
	expect(started).toBe(2)
	expect(finished).toBe(2)
	expect(settled).toBe(true)
})

test('a trigger after settle starts a fresh run', async () => {
	let runs = 0
	const trigger = coalesce(async () => void runs++)
	await trigger()
	await trigger()
	expect(runs).toBe(2)
})

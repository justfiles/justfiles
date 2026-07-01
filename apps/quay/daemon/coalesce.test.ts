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
	coalesce(async () => void runs++)()
	await flush()
	expect(runs).toBe(1)
})

test('collapses a mid-flight burst into one trailing run, without overlapping', async () => {
	const g = gate()
	let started = 0
	let finished = 0
	const trigger = coalesce(async () => {
		started++
		await g.promise
		finished++
	})

	trigger() // leading run starts, awaits the gate
	trigger() // in-flight → queue a trailing run
	trigger() // in-flight → collapses into the SAME trailing run
	trigger()
	expect(started).toBe(1) // never a second concurrent run
	expect(finished).toBe(0)

	g.open()
	await flush()

	// Leading + exactly one trailing run, no matter how many triggers arrived.
	expect(started).toBe(2)
	expect(finished).toBe(2)
})

test('a trigger after settle starts a fresh run', async () => {
	let runs = 0
	const trigger = coalesce(async () => void runs++)
	trigger()
	await flush()
	trigger()
	await flush()
	expect(runs).toBe(2)
})

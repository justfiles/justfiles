import type { Diagnostic } from '@justfiles/app/capabilities/devkit'
import { expect, test, vi } from 'vitest'
import { createProblemChecks } from './editor-check'

const problem = (message: string): Diagnostic => ({
	file: 'src/app.ts',
	range: {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 1 }
	},
	severity: 'error',
	source: 'ts',
	message
})

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

test('keeps one check in flight and shows only the latest change', async () => {
	const first = deferred<Diagnostic[]>()
	const second = deferred<Diagnostic[]>()
	const work = [first, second]
	const shown: Diagnostic[][] = []
	let calls = 0
	const checks = createProblemChecks(
		() => work[calls++]!.promise,
		(diagnostics) => shown.push(diagnostics)
	)

	checks.change()
	checks.run()
	checks.change()
	checks.run()
	checks.change()
	checks.run()

	expect(calls).toBe(1)
	first.resolve([problem('old')])
	await vi.waitFor(() => expect(calls).toBe(2))
	expect(shown).toEqual([])

	second.resolve([problem('current')])
	await vi.waitFor(() => expect(shown).toEqual([[problem('current')]]))
})

test('drops a result after the editor stops', async () => {
	const pending = deferred<Diagnostic[]>()
	const shown: Diagnostic[][] = []
	const checks = createProblemChecks(
		() => pending.promise,
		(diagnostics) => shown.push(diagnostics)
	)

	checks.change()
	checks.run()
	checks.stop()
	pending.resolve([problem('late')])
	await pending.promise
	await Promise.resolve()

	expect(shown).toEqual([])
})

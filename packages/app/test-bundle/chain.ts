import * as v from 'valibot'
import { defineCapability } from '../capabilities/core.ts'
import { defineApp } from '../sdk.ts'

// A 2-deep command cascade: a `fromResult` edge emits ANOTHER command, so the
// kernel's in-flight counter must stay non-zero across the whole chain and
// `settled` must wait for `finished`, not just the emitting `start`.
interface StepMethods {
	run(input: { n: number }): Promise<{ n: number }>
}
const stepper = defineCapability<'stepper', StepMethods>('stepper')

export type ChainState = { value: number; done: boolean }
export const initialState: ChainState = { value: 0, done: false }

export const app = defineApp({
	init: initialState,
	capabilities: { stepper: stepper({ scopes: [] }) },
	update: (t) => ({
		start: t.on(v.object({ n: v.number() }), (state, { n }) => [
			state,
			t.cmd('stepper', 'run', { n }, 'stepped')
		]),
		stepped: t.fromResult('stepper', 'run', (state, r) =>
			r.ok
				? [
						{ ...state, value: r.value.n },
						t.cmd('stepper', 'run', { n: r.value.n + 1 }, 'finished')
					]
				: { ...state, done: true }
		),
		finished: t.fromResult('stepper', 'run', (state, r) =>
			r.ok ? { value: r.value.n, done: true } : { ...state, done: true }
		)
	})
})

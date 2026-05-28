import type { Store } from './index.ts'
import { useStore } from './react.ts'

type State = { count: number; label: string }
type Action = { type: 'inc' }

declare const store: Store<State, Action>

// Type-level acceptance: the selector return type drives the hook result type,
// and a custom equality comparator is accepted. Never rendered — `tsc` checks it.
export function Probe() {
	const count: number = useStore(store, (s) => s.count)
	const label: string = useStore(store, (s) => s.label, Object.is)
	const summary: { count: number } = useStore(
		store,
		(s) => ({ count: s.count }),
		(a, b) => a.count === b.count
	)

	// @ts-expect-error selector returns number, not string
	const wrong: string = useStore(store, (s) => s.count)

	return { count, label, summary, wrong }
}

export interface Store<State, Action> {
	getState(): State
	dispatch(action: Action): void
	subscribe(listener: () => void): () => void
}

export type Effect<State, Action> = (action: Action, previous: State, next: State) => void

export function createStore<State, Action>(options: {
	initialState: State
	reducer: (state: State, action: Action) => State
	effects?: readonly Effect<State, Action>[]
}): Store<State, Action> {
	let state = options.initialState
	const listeners = new Set<() => void>()

	return {
		getState: () => state,
		dispatch(action) {
			const previous = state
			const next = options.reducer(previous, action)
			if (Object.is(previous, next)) return
			state = next
			for (const listener of listeners) listener()
			for (const effect of options.effects ?? []) effect(action, previous, next)
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		}
	}
}

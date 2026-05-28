export type MaybePromise<T> = T | Promise<T>
export type Unsubscribe = () => void

export interface Store<State, Action> {
	getState(): State
	dispatch(action: Action): void
	subscribe(listener: () => void): Unsubscribe
}

export type Reducer<State, Action> = (state: State, action: Action) => State

export type EffectContext<State, Action> = {
	getState(): State
	dispatch(action: Action): void
}

export type Effect<State, Action> = (
	action: Action,
	previous: State,
	next: State,
	ctx: EffectContext<State, Action>
) => MaybePromise<void>

export function createStore<State, Action>(options: {
	initialState: State
	reducer: Reducer<State, Action>
	effects?: readonly Effect<State, Action>[]
}): Store<State, Action> {
	let state = options.initialState
	const listeners = new Set<() => void>()
	const effects = options.effects ?? []
	const queue: Action[] = []
	let processing = false

	function getState(): State {
		return state
	}

	function subscribe(listener: () => void): Unsubscribe {
		listeners.add(listener)
		return () => {
			listeners.delete(listener)
		}
	}

	function dispatch(action: Action): void {
		queue.push(action)
		if (processing) return
		processing = true
		try {
			while (queue.length > 0) {
				const current = queue.shift() as Action
				const previous = state
				const next = options.reducer(previous, current)
				if (Object.is(previous, next)) continue
				state = next
				for (const listener of listeners) listener()
				for (const effect of effects) {
					try {
						const result = effect(current, previous, next, ctx)
						if (result instanceof Promise) {
							result.catch((error) => {
								console.error(error)
							})
						}
					} catch (error) {
						console.error(error)
					}
				}
			}
		} finally {
			processing = false
		}
	}

	const ctx: EffectContext<State, Action> = { getState, dispatch }

	return { getState, dispatch, subscribe }
}

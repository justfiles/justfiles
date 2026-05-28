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

export function createStore<State, Action>(_options: {
	initialState: State
	reducer: Reducer<State, Action>
	effects?: readonly Effect<State, Action>[]
}): Store<State, Action> {
	throw new Error('createStore: not implemented (Step 2)')
}

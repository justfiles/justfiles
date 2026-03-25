export type RuntimeTransitionResult<S, F> = {
	state: S
	effects: F[]
}

export type RuntimeTransition<S, E, F> = (
	state: S,
	event: E
) => RuntimeTransitionResult<S, F>

export type RuntimeEffectContext<S, E> = {
	dispatch(event: E): Promise<void>
	transition(event: E): Promise<void>
	getState(): S
}

export type RuntimeEffectRunner<S, E, F> = (
	effect: F,
	context: RuntimeEffectContext<S, E>
) => Promise<void> | void

export type MachineRuntime<S, E> = {
	readonly state: S
	dispatch(event: E): Promise<void>
	destroy(): void
}

type SerialQueue = {
	run<T>(fn: () => Promise<T>): Promise<T>
}

function createSerialQueue(): SerialQueue {
	let chain: Promise<void> = Promise.resolve()
	return {
		run<T>(fn: () => Promise<T>): Promise<T> {
			const next = chain.then(fn, fn) as Promise<T>
			chain = next.then(() => {}, () => {})
			return next
		}
	}
}

export function createMachineRuntime<S, E, F>(args: {
	initialState: S
	transition: RuntimeTransition<S, E, F>
	runEffect: RuntimeEffectRunner<S, E, F>
	onDestroy?: () => void
}): MachineRuntime<S, E> {
	const { initialState, transition, runEffect, onDestroy } = args

	const queue = createSerialQueue()
	let state = initialState

	const context: RuntimeEffectContext<S, E> = {
		dispatch,
		transition: transitionNow,
		getState: () => state
	}

	async function runEffects(effects: F[]): Promise<void> {
		for (const effect of effects) {
			await runEffect(effect, context)
		}
	}

	async function transitionNow(event: E): Promise<void> {
		const next = transition(state, event)
		state = next.state
		await runEffects(next.effects)
	}

	async function dispatch(event: E): Promise<void> {
		return queue.run(async () => {
			await transitionNow(event)
		})
	}

	function destroy(): void {
		onDestroy?.()
	}

	return {
		get state() {
			return state
		},
		dispatch,
		destroy
	}
}

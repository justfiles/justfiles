export class StaleLifetimeError<T> extends Error {
	readonly expected: T
	readonly actual: T

	constructor(expected: T, actual: T) {
		super('Lifetime is stale')
		this.name = 'StaleLifetimeError'
		this.expected = expected
		this.actual = actual
	}
}

export interface LifetimeToken<T> {
	readonly value: T
	assertCurrent(): void
}

export interface LifetimeGate<T> {
	current(): LifetimeToken<T>
	replace(value: T): LifetimeToken<T>
}

export function createLifetimeGate<T>(initial: T): LifetimeGate<T> {
	let current: LifetimeToken<T>

	function createToken(value: T): LifetimeToken<T> {
		const token: LifetimeToken<T> = {
			value,
			assertCurrent() {
				if (current !== token) {
					throw new StaleLifetimeError(value, current.value)
				}
			}
		}
		return Object.freeze(token)
	}

	current = createToken(initial)
	return {
		current: () => current,
		replace(value) {
			current = createToken(value)
			return current
		}
	}
}

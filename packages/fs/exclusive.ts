export function createExclusiveRunner() {
	let tail = Promise.resolve()

	return async function runExclusive<T>(task: () => Promise<T>): Promise<T> {
		const run = tail.then(task, task)
		tail = run.then(
			() => undefined,
			() => undefined
		)
		return run
	}
}

export function createKeyedExclusiveRunner<K>() {
	const tails = new Map<K, Promise<void>>()

	return async function runExclusive<T>(key: K, task: () => Promise<T>): Promise<T> {
		const previous = tails.get(key) ?? Promise.resolve()
		const run = previous.then(task, task)
		const completion = run.then(
			() => undefined,
			() => undefined
		)

		tails.set(key, completion)

		try {
			return await run
		} finally {
			if (tails.get(key) === completion) {
				tails.delete(key)
			}
		}
	}
}

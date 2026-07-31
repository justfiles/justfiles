/**
 * One task at a time, in call order — a promise chain, not a lock with owners, so
 * there is nothing to release and a rejected task does not wedge the queue. Used by
 * `nativeStorage.atomicMove` to keep its look at the destination and the rename that
 * takes it in one turn (see there for what that does and does not promise).
 */
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

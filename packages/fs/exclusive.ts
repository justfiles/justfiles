/**
 * One task at a time, in call order — a promise chain, not a lock with owners, so
 * there is nothing to release and a rejected task does not wedge the queue. Used by
 * `nativeStorage` for its `claims` chain: every step that takes a name runs on it, so a
 * create's publish and an exclusive move's look-then-rename cannot interleave.
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

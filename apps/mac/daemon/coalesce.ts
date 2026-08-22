/** Run at once, fold each in-flight burst into one trailing run, and resolve when idle. */
export function coalesce(fn: () => Promise<void>): () => Promise<void> {
	let running: Promise<void> | undefined
	let queued = false
	const run = async (): Promise<void> => {
		do {
			queued = false
			await fn()
		} while (queued)
	}
	return () => {
		if (running) queued = true
		else
			running = run().finally(() => {
				running = undefined
			})
		return running
	}
}

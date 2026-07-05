// Collapse a flood of triggers into a single-flight action that always converges
// to the latest state. The returned trigger runs `fn` immediately (leading edge);
// any trigger that arrives while a run is in flight schedules exactly ONE more run
// after it settles (trailing edge), collapsing N concurrent triggers into that one
// re-run. Runs never overlap, so `fn` can do serial I/O (fs writes, socket
// broadcasts) without racing itself.
//
// This is the shape the catalog reconcile wants — react to the first install/
// uninstall with no delay, suppress the burst, and let the trailing run reflect
// whatever the last suppressed trigger would have seen. It's a consumer-side
// policy, deliberately NOT baked into the kernel event bus, which stays a faithful
// deliver-everything channel.
export function coalesce(fn: () => Promise<void>): () => void {
	let running: Promise<void> | undefined
	let queued = false
	const run = (): void => {
		running = (async () => {
			try {
				await fn()
			} finally {
				running = undefined
				if (queued) {
					queued = false
					run()
				}
			}
		})()
	}
	return () => {
		if (running) queued = true
		else run()
	}
}

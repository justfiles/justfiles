import type { Diagnostic } from '@justfiles/app/capabilities/devkit'

// Keep one check in flight. A change makes its result stale, and any runs
// requested before it ends become one last check.
export function createProblemChecks(
	check: () => Promise<Diagnostic[]>,
	show: (diagnostics: Diagnostic[]) => void
) {
	let version = 0
	let running = false
	let again = false
	let stopped = false

	const run = async () => {
		if (running || stopped) return
		running = true
		try {
			do {
				again = false
				const started = version
				const diagnostics = await check()
				if (!stopped && started === version) show(diagnostics)
			} while (again && !stopped)
		} finally {
			running = false
		}
	}

	return {
		change() {
			version++
		},
		run() {
			if (stopped) return
			again = true
			void run()
		},
		stop() {
			stopped = true
			again = false
		}
	}
}

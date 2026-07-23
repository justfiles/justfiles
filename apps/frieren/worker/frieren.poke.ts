const DEBOUNCE_MS = 1_000
const MAX_WAIT_MS = 5_000

export function createServerPoke(send: () => void): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined
	let startedAt: number | undefined
	return () => {
		const now = Date.now()
		startedAt ??= now
		if (timer) clearTimeout(timer)
		timer = setTimeout(
			() => {
				timer = undefined
				startedAt = undefined
				send()
			},
			Math.min(DEBOUNCE_MS, MAX_WAIT_MS - (now - startedAt))
		)
	}
}

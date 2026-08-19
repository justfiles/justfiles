import { forwarded, type Store } from '@justfiles/fs/store'

// Intentionally mirrors @justfiles/fs's scheduler without exporting a generic timing API.
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

/**
 * A `Store` that tells the poke when a commit lands.
 *
 * `sqliteStore` offers no `subscribe`, and it is right not to: the DATABASE is the
 * store there, so a wake held in one process's closure would never fire for another
 * process's commit. On a Durable Object there IS no other process — this instance is
 * the one writer for this user, and every write reaches the tree through the store it
 * wraps — so the wake it cannot promise in general is exactly the wake this host can.
 */
export const poking = (store: Store, changed: () => void): Store => ({
	...forwarded(store),
	async commit(writes, guards) {
		await store.commit(writes, guards)
		if (writes.length > 0) changed()
	}
})

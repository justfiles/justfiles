import { forwarded, type Node, type Store } from '@justfiles/fs/store'

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
 * A `Store` with the `subscribe` its backend deliberately does not have.
 *
 * `sqliteStore` offers none, and it is right not to: the DATABASE is the store there,
 * so a wake held in one process's closure would never fire for another process's
 * commit, and a consumer takes `subscribe` INSTEAD of polling `since`. On a Durable
 * Object there IS no other process — this instance is the one writer for this user,
 * and every write reaches the tree through the store this wraps — so the wake the
 * backend cannot promise in general is exactly the wake this host can.
 *
 * Two consumers take it: `storeVolume`'s watch, which then stops polling SQLite on a
 * timer, and the server->client poke, which is an ordinary subscriber.
 */
export const notifying = (store: Store): Store => {
	const listeners = new Set<(writes: Node[]) => void>()
	return {
		...forwarded(store),
		async commit(writes, guards) {
			await store.commit(writes, guards)
			if (writes.length === 0) return
			for (const listener of listeners) listener(writes)
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		}
	}
}

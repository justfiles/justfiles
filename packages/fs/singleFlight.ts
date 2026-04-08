export interface SingleFlight<K, V> {
	run(key: K, task: () => Promise<V>): Promise<V>
	delete(key: K): void
	deleteWhere(predicate: (key: K) => boolean): void
	clear(): void
}

/**
 * Deduplicates concurrent work for the same key.
 *
 * If multiple callers request the same key while the first task is still
 * running, they all await the same Promise. Once that Promise settles, the
 * key is removed so a later caller starts fresh work.
 */
export function createSingleFlight<K, V>(): SingleFlight<K, V> {
	const inFlight = new Map<K, Promise<V>>()

	return {
		run(key, task) {
			const existing = inFlight.get(key)
			if (existing) return existing

			const request = (async () => {
				try {
					return await task()
				} finally {
					inFlight.delete(key)
				}
			})()

			inFlight.set(key, request)
			return request
		},

		delete(key) {
			inFlight.delete(key)
		},

		deleteWhere(predicate) {
			for (const key of inFlight.keys()) {
				if (predicate(key)) {
					inFlight.delete(key)
				}
			}
		},

		clear() {
			inFlight.clear()
		},
	}
}

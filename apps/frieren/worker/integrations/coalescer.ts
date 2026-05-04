type Pending = () => void | Promise<void>

export class Coalescer {
	private busy = false
	private queue: Pending[] = []

	async schedule(fn: Pending): Promise<void> {
		if (!this.busy) {
			await fn()
			return
		}
		this.queue.push(fn)
	}

	async during<T>(work: () => Promise<T>): Promise<T> {
		this.busy = true
		try {
			return await work()
		} finally {
			this.busy = false
			const pending = this.queue
			this.queue = []
			for (const fn of pending) await fn()
		}
	}
}

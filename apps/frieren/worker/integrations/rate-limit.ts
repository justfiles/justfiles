interface BucketState {
	count: number
	windowStart: number
}

export interface TokenBucketOptions {
	capacity: number
	windowMs: number
	now?: () => number
}

export class TokenBucket {
	private readonly capacity: number
	private readonly windowMs: number
	private readonly now: () => number
	private readonly buckets = new Map<string, BucketState>()

	constructor(options: TokenBucketOptions) {
		this.capacity = options.capacity
		this.windowMs = options.windowMs
		this.now = options.now ?? (() => Date.now())
	}

	take(key: string): boolean {
		const t = this.now()
		const state = this.buckets.get(key)
		if (!state || t - state.windowStart >= this.windowMs) {
			this.buckets.set(key, { count: 1, windowStart: t })
			return true
		}
		if (state.count >= this.capacity) return false
		state.count++
		return true
	}
}

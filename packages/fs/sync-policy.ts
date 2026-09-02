/** Whole days as milliseconds. */
export const days = (n: number): number => n * 24 * 60 * 60 * 1000

/** Whole minutes as milliseconds. */
export const minutes = (n: number): number => n * 60 * 1000

export const DEFAULT_SYNC_POLICY = {
	cursorLeaseMs: days(30),
	writeLeaseMs: minutes(15),
	maxWriteDurationMs: minutes(5),
	tombstoneFenceAgeMs: days(30),
	tombstoneGraceMs: days(10),
	deleteBatch: 128
} as const

export type SyncPolicy = {
	readonly cursorLeaseMs: number
	readonly writeLeaseMs: number
	readonly maxWriteDurationMs: number
	readonly tombstoneFenceAgeMs: number
	readonly tombstoneGraceMs: number
	readonly deleteBatch: number
}

export function validateSyncPolicy(policy: SyncPolicy): void {
	if (policy.tombstoneFenceAgeMs < policy.cursorLeaseMs) {
		throw new Error('tombstoneFenceAge must be >= cursorLease')
	}
	if (policy.tombstoneGraceMs <= policy.writeLeaseMs + policy.maxWriteDurationMs) {
		throw new Error('tombstoneGrace must be > writeLease + maxWriteDuration')
	}
}

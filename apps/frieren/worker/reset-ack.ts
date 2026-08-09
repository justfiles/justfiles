import type { DestructiveResetBody, ResetResult, ResetStatus } from '@justfiles/core'

export type AcknowledgedResetResult =
	| ResetResult
	| { ok: false; error: 'reset_unconfirmed'; generation?: number }

export interface ResetRestartStub {
	resetAndRestart(request: DestructiveResetBody): Promise<ResetResult>
	resetStatus(operationId: string): Promise<ResetStatus>
}

// Backoff for the confirmation. Deliberately starts non-zero: the first attempt would
// otherwise land on an instance that is still being torn down and be spent proving nothing.
// Sums to ~3s, enough to absorb a cold start plus the constructor's migration.
const CONFIRM_DELAYS_MS = [50, 100, 200, 400, 800, 1600] as const

const sleep = (delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay))

/**
 * The outer Worker's half of a destructive reset: ask, expect to be hung up on, then
 * reconnect and find out what happened.
 *
 * A committed reset never answers — the instance flushes to disk and destroys itself in the
 * same turn (reset-instance.ts), which is what guarantees nothing of it survives to write
 * into the tree it just created. So the disconnect carries no information on its own, and
 * the proof is read afterwards from durable storage instead: `resetStatus` says whether THIS
 * operation is the one the volume last committed.
 *
 * Every call takes a FRESH stub. `abort()` tears down the RPC session, so the handle the
 * reset went out on is dead and can never reach a replacement — polling it is why the first
 * version of this protocol confirmed nothing in production, across two resets and ten
 * attempts (#425). Reconnecting is the whole trick, exactly as it is after a remote reboot.
 *
 * Failing to confirm is reported as such and never guessed. The client keeps its durable
 * `operationId`, so a retry either replays the same committed reset or lands as a fresh one
 * against the generation it finds — never a second destructive reset it did not ask for.
 */
export async function acknowledgeReset(
	connect: () => ResetRestartStub,
	request: DestructiveResetBody,
	options: { delays?: readonly number[]; wait?: (delay: number) => Promise<void> } = {}
): Promise<AcknowledgedResetResult> {
	try {
		const result = await connect().resetAndRestart(request)
		// Anything returned is a decision the instance survived to report: a stale CAS, or a
		// replay of an operation whose committing instance is already gone. A fresh commit
		// cannot reach here, and if it somehow does, the confirmation below still settles it.
		if (!result.ok || result.replayed) return result
	} catch {
		// Expected: the instance committed and took the call down with it. Ambiguous until
		// storage says otherwise — a reset that failed before committing looks identical.
	}

	let generation: number | undefined
	for (const delay of options.delays ?? CONFIRM_DELAYS_MS) {
		await (options.wait ?? sleep)(delay)
		try {
			const status = await connect().resetStatus(request.operationId)
			generation = status.generation
			if (status.committed) return { ok: true, generation: status.generation }
		} catch {
			// Still tearing down, or the replacement is still starting: the next attempt tries
			// again on another new handle.
		}
	}
	return { ok: false, error: 'reset_unconfirmed', generation }
}

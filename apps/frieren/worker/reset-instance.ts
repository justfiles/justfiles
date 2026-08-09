import type { DestructiveResetBody, ResetDecision, ResetResult } from '@justfiles/core'

/**
 * The committing half of a destructive reset, inside the Durable Object.
 *
 * `sync()` is the whole point of this seam, and it is `sync` before `reboot`: the DO's
 * SQLite writes ride the event's implicit transaction, which is only committed when the
 * output gate opens. The restart that follows this call deliberately stops that from
 * happening, so without an explicit flush the truncate + generation bump are discarded
 * along with the aborted event — the reset silently does nothing (see #425).
 *
 * Terminating is NOT done here. The instance stays alive just long enough to answer with
 * the generation it committed; the authenticated Worker then restarts it over a fresh
 * handle (reset-ack.ts). An `abort()` from inside this call would take the answer with it.
 */
export async function commitReset(
	request: DestructiveResetBody,
	operations: {
		reset(request: DestructiveResetBody): Promise<ResetDecision>
		sync(): Promise<void>
	}
): Promise<ResetResult> {
	const decision = await operations.reset(request)
	if (!decision.ok) return decision
	// A replay changed nothing, so there is nothing pending to flush — but the caller
	// cannot tell the two apart, and flushing an empty buffer resolves immediately.
	await operations.sync()
	if (decision.replayed) return { ok: true, generation: decision.next.generation, replayed: true }
	return { ok: true, generation: decision.next.generation }
}

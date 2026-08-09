import type { DestructiveResetBody, ResetDecision, ResetResult } from '@justfiles/core'

/**
 * A destructive reset, inside the Durable Object: commit, flush, die.
 *
 * The order is the whole design. `sync()` is `sync` before `reboot`: DO SQLite writes ride
 * the event's implicit transaction, which is only committed when the output gate opens, and
 * the termination that follows deliberately stops that from ever happening. Without the
 * flush the truncate and the generation bump are discarded along with the aborted event and
 * the reset silently does nothing — which is exactly what production was doing (#425).
 *
 * `terminate` never returns, and that is what makes this safe rather than merely correct:
 * the instance is destroyed in the same turn that changed the filesystem under it, so no
 * continuation, timer, open transaction or socket handler survives to write into the tree
 * the reset just created. There is no window to fence, because there is no instance.
 *
 * A replay neither flushes nor terminates. Commit and termination are atomic here, so a
 * recorded operation proves the instance that made it is already gone — whoever is
 * answering now was built afterwards and owns the generation it is serving.
 */
export async function commitReset(
	request: DestructiveResetBody,
	operations: {
		reset(request: DestructiveResetBody): Promise<ResetDecision>
		sync(): Promise<void>
		terminate(reason: string): never
	}
): Promise<ResetResult> {
	const decision = await operations.reset(request)
	if (!decision.ok) return decision
	if (decision.replayed) return { ok: true, generation: decision.next.generation, replayed: true }
	await operations.sync()
	return operations.terminate(`filesystem reset: ${request.operationId}`)
}

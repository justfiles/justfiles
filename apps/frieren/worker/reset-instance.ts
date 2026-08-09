import type { DestructiveResetBody, ResetDecision, ResetResult } from '@justfiles/core'

export async function commitResetAndRestart(
	request: DestructiveResetBody,
	operations: {
		reset(request: DestructiveResetBody): Promise<ResetDecision>
		terminate(reason: string): never
	}
): Promise<ResetResult> {
	const decision = await operations.reset(request)
	if (!decision.ok) return decision
	if (decision.replayed) return { ok: true, generation: decision.next.generation, replayed: true }
	return operations.terminate(`filesystem reset: ${request.operationId}`)
}

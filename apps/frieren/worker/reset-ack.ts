import type { DestructiveResetBody, ResetResult, ResetStatus } from '@justfiles/core'

export type AcknowledgedResetResult =
	| ResetResult
	| { ok: false; error: 'reset_unconfirmed'; generation?: number }

export interface ResetRestartStub {
	resetAndRestart(request: DestructiveResetBody): Promise<ResetResult>
	resetStatus(operationId: string): Promise<ResetStatus>
}

const CONFIRM_DELAYS_MS = [0, 50, 200, 500, 1_000] as const

const sleep = (delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay))

export async function acknowledgeReset(
	stub: ResetRestartStub,
	request: DestructiveResetBody,
	options: {
		delays?: readonly number[]
		wait?: (delay: number) => Promise<void>
	} = {}
): Promise<AcknowledgedResetResult> {
	try {
		const result = await stub.resetAndRestart(request)
		if (!result.ok || result.replayed) return result
	} catch {
		// Expected after a committed reset, but ambiguous until durable status proves it.
	}

	let generation: number | undefined
	for (const delay of options.delays ?? CONFIRM_DELAYS_MS) {
		if (delay > 0) await (options.wait ?? sleep)(delay)
		try {
			const status = await stub.resetStatus(request.operationId)
			generation = status.generation
			if (status.committed) return { ok: true, generation: status.generation }
		} catch {
			// Instance replacement can reject briefly; the bounded next attempt retries it.
		}
	}
	return { ok: false, error: 'reset_unconfirmed', generation }
}

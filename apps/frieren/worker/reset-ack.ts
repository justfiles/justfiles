import type { DestructiveResetBody, ResetResult } from '@justfiles/core'

export interface ResetRestartStub {
	status(): Promise<{ instanceId: string; generation: number }>
	commitReset(request: DestructiveResetBody): Promise<ResetResult>
	terminate(reason: string): Promise<void>
}

// Backoff for the readiness probe. Sums to ~3s, against a restart that normally takes
// milliseconds — long enough to absorb a cold start plus the constructor's migration.
const RESTART_DELAYS_MS = [50, 100, 200, 400, 800, 1600] as const

const sleep = (delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay))

/**
 * The outer Worker's half of a destructive reset: commit, restart, wait for the
 * replacement, then answer.
 *
 * The commit is acknowledged BEFORE anything is torn down. The Durable Object flushes to
 * disk and returns the generation it committed (reset-instance.ts), and the output gate
 * holds that response until the write is durable — so the returned generation IS the proof.
 * Nothing about the restart has to be interpreted as evidence. The protocol this replaced
 * committed and aborted in one call and then tried to prove the commit afterwards, over a
 * handle the abort had already killed: it could never confirm anything, and the commit did
 * not survive the abort either (#425).
 *
 * Waiting for the replacement is therefore a READINESS check, not proof — which is what
 * makes it safe to give up on. Its job is to keep the client from being told "done" while
 * the old instance could still answer with modules built over the filesystem that just
 * went away. A probe that times out costs legibility, never correctness: the reset is
 * already durable, and the old instance is refusing traffic on its own account meanwhile.
 *
 * "Is it back?" is answered by a CHANGED `instanceId`, not by the generation. The old
 * instance reads the same reset SQLite and reports the same generation, so only the
 * in-memory identity distinguishes the two — the same reason a reboot check compares
 * `/proc/sys/kernel/random/boot_id` rather than trusting that the host answered.
 *
 * A replay is not restarted. That operation already committed and the instance answering
 * it was rebuilt after the commit, so it owns the generation it is serving.
 */
export async function resetAndTerminate(
	connect: () => ResetRestartStub,
	request: DestructiveResetBody,
	options: { delays?: readonly number[]; wait?: (delay: number) => Promise<void> } = {}
): Promise<ResetResult> {
	const stub = connect()
	const before = await stub.status()
	const result = await stub.commitReset(request)
	if (!result.ok || result.replayed) return result
	// Never awaited for success: the call dies with the object it tears down, so a rejection
	// is the expected outcome. The probe below is what keeps the event alive until it lands.
	void stub.terminate(`filesystem reset: ${request.operationId}`).catch(() => {})
	if (!(await restarted(connect, before.instanceId, options)))
		console.warn(`reset ${request.operationId}: committed, but the restart went unconfirmed`)
	return result
}

async function restarted(
	connect: () => ResetRestartStub,
	previous: string,
	options: { delays?: readonly number[]; wait?: (delay: number) => Promise<void> }
): Promise<boolean> {
	for (const delay of options.delays ?? RESTART_DELAYS_MS) {
		await (options.wait ?? sleep)(delay)
		try {
			// A FRESH handle every attempt. `abort()` tears down the RPC session, so the stub
			// the terminate went out on can never reach the object again — reusing it is how
			// the previous protocol managed to never once reach a replacement instance.
			if ((await connect().status()).instanceId !== previous) return true
		} catch {
			// Mid-teardown, or the replacement is still starting: the next attempt retries.
		}
	}
	return false
}

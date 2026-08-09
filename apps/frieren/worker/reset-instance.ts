import type {
	DbAdapter,
	DestructiveResetBody,
	ResetDecision,
	ResetResult,
	SqlValue
} from '@justfiles/core'

/**
 * The instance's write boundary, closed once it stands down.
 *
 * Entry checks cannot cover work that is already past them: an agent turn or capability
 * call awaiting model or tool I/O when a reset commits resumes AFTERWARDS and appends to
 * the tree the reset just created (`assistant.ts` writes its transcript after the model
 * returns). Draining instead would mean holding the reset behind AI I/O, which is exactly
 * what #425 rules out.
 *
 * Every filesystem write in the Durable Object goes through one `DbAdapter`, so this is the
 * single place all of that work can be stopped at once — no per-caller cooperation, no
 * cancellation plumbing. Reads stay open, so a closed instance can still say who it is.
 *
 * Terminal, not a generation fence: it never reopens, because the instance it belongs to is
 * on its way out. The replacement builds its own.
 */
export function refuseWritesWhile(db: DbAdapter, restarting: () => boolean): DbAdapter {
	const refuse = () => {
		if (restarting()) throw new Error('durable object is restarting')
	}
	// `async`, so a refusal is a REJECTED promise rather than a synchronous throw: these are
	// declared to return one, and a caller that only attaches `.catch()` would otherwise be
	// hit by an exception it has no way to see coming.
	return {
		query: <T extends Record<string, unknown>>(sql: string, args?: SqlValue[]) =>
			db.query<T>(sql, args),
		run: async (sql: string, args?: SqlValue[]) => {
			refuse()
			return db.run(sql, args)
		},
		transaction: async (fn: (tx: DbAdapter) => Promise<void>) => {
			refuse()
			return db.transaction(fn)
		}
	}
}

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

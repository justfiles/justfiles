import type { DbAdapter, SqlValue } from './db'

interface BunDatabase {
	prepare(sql: string): { all(...args: SqlValue[]): unknown[]; run(...args: SqlValue[]): void }
	exec(sql: string): void
}

/**
 * A `DbAdapter` over ONE synchronous connection (`node:sqlite`, bun's `Database`).
 *
 * That single connection is the whole reason this file has any logic in it. Every
 * transaction body here is `async` and awaits mid-way (`sqliteStorage`'s mutations resolve
 * paths and enumerate subtrees inside theirs), so two overlapping callers interleave on one
 * connection — and one connection cannot hold two transactions. Unserialised, the damage is
 * not just the obvious error (#339):
 *
 *   - the second `BEGIN` fails with "cannot start a transaction within a transaction", which
 *     is not a word any caller knows (`claimPath` retries EEXIST and rethrows the rest);
 *   - the two overlapping callers are then in the SAME transaction, so the loser's
 *     `ROLLBACK` throws away the winner's committed rows, and any statement issued in that
 *     window goes with it;
 *   - and a read from outside lands inside whatever transaction is open, so it can observe a
 *     half-applied middle — a rename with its old entry deleted and its new one not yet
 *     written — that no commit ever produced.
 *
 * One fact, so one fix: statements and transactions enter through a queue, and the body gets
 * an adapter that is ALREADY inside the transaction, so its own statements run straight
 * through instead of waiting for a lock its caller holds. A nested `transaction` is likewise
 * the same transaction, because SQLite has no nesting (a real one would need SAVEPOINT, and
 * nothing here asks for that).
 *
 * Serialising costs nothing to lose: the driver is synchronous, so there was never any
 * parallelism here — only JS interleaving between awaits, which is exactly the hazard. And
 * `DbAdapter` is unchanged: this is the driver keeping the promise the word "transaction"
 * already made, not a new capability for callers to reason about.
 *
 * The DO adapter (`createDOSqliteAdapter`) needs none of this: it issues no `BEGIN` at all
 * and leans on the Durable Object running one event at a time.
 */
export function createSqliteAdapter(db: BunDatabase): DbAdapter {
	db.exec('PRAGMA foreign_keys = ON')

	async function query<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		args: SqlValue[] = []
	): Promise<T[]> {
		return db.prepare(sql).all(...args) as T[]
	}

	async function exec(sql: string, args: SqlValue[] = []): Promise<void> {
		db.prepare(sql).run(...args)
	}

	// The adapter a transaction body receives: no queue (it is the holder), and `transaction`
	// is the identity, since it is already in one.
	const inside: DbAdapter = { query, run: exec, transaction: (fn) => fn(inside) }

	// One statement or transaction at a time, in call order — a promise chain, so there is
	// nothing to release and a rejected task cannot wedge the queue.
	let tail: Promise<unknown> = Promise.resolve()
	function serially<T>(task: () => Promise<T>): Promise<T> {
		const next = tail.then(task, task)
		tail = next.then(
			() => undefined,
			() => undefined
		)
		return next
	}

	return {
		query: (sql, args) => serially(() => query(sql, args)),
		run: (sql, args) => serially(() => exec(sql, args)),
		transaction: (fn) =>
			serially(async () => {
				db.exec('BEGIN')
				try {
					await fn(inside)
					db.exec('COMMIT')
				} catch (e) {
					db.exec('ROLLBACK')
					throw e
				}
			})
	}
}

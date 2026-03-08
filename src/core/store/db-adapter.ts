// Unified adapter interface over bun:sqlite and @libsql/client.
// All methods are async so the interface works with both sync (bun:sqlite) and
// async (libsql) backends.

export type SqlValue = null | string | number | bigint | Uint8Array | ArrayBuffer

export interface DbAdapter {
	query<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		args?: SqlValue[]
	): Promise<T[]>
	run(sql: string, args?: SqlValue[]): Promise<void>
	transaction(fn: (tx: DbAdapter) => Promise<void>): Promise<void>
}

// ---- bun:sqlite adapter (Bun/Node only, tree-shaken from CF Workers bundle) ----

interface BunDatabase {
	prepare(sql: string): { all(...args: SqlValue[]): unknown[]; run(...args: SqlValue[]): void }
	exec(sql: string): void
}

export function createSqliteAdapter(db: BunDatabase): DbAdapter {
	const adapter: DbAdapter = {
		async query<T extends Record<string, unknown>>(sql: string, args: SqlValue[] = []): Promise<T[]> {
			return db.prepare(sql).all(...args) as T[]
		},
		async run(sql: string, args: SqlValue[] = []): Promise<void> {
			db.prepare(sql).run(...args)
		},
		async transaction(fn: (tx: DbAdapter) => Promise<void>): Promise<void> {
			db.exec('BEGIN')
			try {
				await fn(adapter)
				db.exec('COMMIT')
			} catch (e) {
				db.exec('ROLLBACK')
				throw e
			}
		}
	}
	return adapter
}

// ---- libsql adapter (universal — use @libsql/client/web for CF Workers) ----

export function createLibsqlAdapter(client: import('@libsql/client').Client): DbAdapter {
	type Executor = { execute(stmt: { sql: string; args: SqlValue[] }): Promise<{ rows: unknown[] }> }

	function fromExecutor(executor: Executor): DbAdapter {
		return {
			async query<T extends Record<string, unknown>>(sql: string, args: SqlValue[] = []): Promise<T[]> {
				const result = await executor.execute({ sql, args })
				return result.rows as T[]
			},
			async run(sql: string, args: SqlValue[] = []): Promise<void> {
				await executor.execute({ sql, args })
			},
			async transaction(fn: (tx: DbAdapter) => Promise<void>): Promise<void> {
				const tx = await client.transaction('write')
				try {
					await fn(fromExecutor(tx))
					await tx.commit()
				} catch (e) {
					await tx.rollback()
					throw e
				}
			}
		}
	}

	return fromExecutor(client)
}

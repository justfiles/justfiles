import type { DbAdapter, SqlValue } from './db'

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

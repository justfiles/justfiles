// Runs the shared path-sync backend conformance suite (`pathSyncConformanceCases`,
// in `packages/sync/sync-test-harness.ts`) against the SQLite/DO backend under vitest.
// This is the same suite that runs against `memStorage` and `idbStorage` in
// `packages/sync/sync-conformance.test.ts` — proving the SHIPPING backends against
// identical specs, not just the memStorage test double.
//
// The backend takes an abstract `DbAdapter`; here we back it with node's built-in
// `node:sqlite` (`DatabaseSync`), so it runs under the normal `pnpm test` (vitest /
// node) — no bun. `createSqliteAdapter`'s minimal db surface (`prepare().all/.run`
// + `exec`) is structurally satisfied by `DatabaseSync`.

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'vitest'
import { pathSyncConformanceCases } from '../../sync/sync-test-harness'
import { createSqliteAdapter } from './db.sqlite'
import { storage as sqliteStorage } from './storage.sqlite'

// Apply every migration in order (0001, 0002, …) exactly as the DO does via
// coreMigrations — so path-sync tables are present in the test DB too.
const migrationsDir = new URL('./migrations/', import.meta.url)
const schema = readdirSync(migrationsDir)
	.filter((f) => f.endsWith('.sql'))
	.sort()
	.map((f) => readFileSync(new URL(f, migrationsDir), 'utf8'))
	.join('\n')

/** Fresh in-memory SQLite backend per call (node:sqlite is synchronous). */
const makeSqlite = () => {
	const db = new DatabaseSync(':memory:')
	db.exec(schema)
	// node:sqlite returns INTEGER as a JS number by default and THROWS on values
	// beyond 2^53 (e.g. mtimeNs). Read integers as bigint — storage's toNumber /
	// toBigInt already accept bigint (bun:sqlite / the DO adapter handle this too).
	const db64 = {
		prepare(sql: string) {
			const stmt = db.prepare(sql)
			stmt.setReadBigInts(true)
			return stmt
		},
		exec: (sql: string) => db.exec(sql)
	}
	return sqliteStorage(
		createSqliteAdapter(db64 as unknown as Parameters<typeof createSqliteAdapter>[0])
	)
}

describe('path-sync conformance: sqliteStorage', () => {
	for (const c of pathSyncConformanceCases) {
		test(c.name, () => c.run(makeSqlite))
	}
})

// Runs the shared path-sync backend conformance suite (`packages/fs/sync-conformance`)
// against the SQLite/DO backend under `bun test` (it needs `bun:sqlite`). This is the
// same suite vitest runs against `memStorage` (GREEN) and `idbStorage` (RED) — proving
// the SHIPPING backends against identical specs, not just the memStorage test double.
//
// RED until the SQLite backend implements the path-sync seams (`caps.journal` /
// `caps.pathApply` / `caps.content` + local-mutation journaling): the backend
// CONSTRUCTS and does base writes fine, then each case fails for the RIGHT reason
// (`not implemented`), turning GREEN when the backend lands.
//
// Excluded from the node vitest run (see vitest.config.ts) and from tsc (see
// packages/core/tsconfig.json exclude — no @types/bun here).

import { Database } from 'bun:sqlite'
import { describe, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { pathSyncConformanceCases } from '../../fs/sync-conformance'
import { createSqliteAdapter } from './db.sqlite'
import { storage as sqliteStorage } from './storage.sqlite'

const schema = readFileSync(new URL('./migrations/0001_schema.sql', import.meta.url), 'utf8')

/** Fresh in-memory SQLite backend per call (bun:sqlite is synchronous). */
const makeSqlite = () => {
	const db = new Database(':memory:')
	db.exec(schema)
	return sqliteStorage(createSqliteAdapter(db))
}

describe('path-sync conformance: sqliteStorage (bun)', () => {
	for (const c of pathSyncConformanceCases) {
		test(c.name, () => c.run(makeSqlite))
	}
})

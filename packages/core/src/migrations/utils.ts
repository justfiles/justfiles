import type { SqlValue } from '../db'

export function parseSqlStatements(sql: string): string[] {
	const statements: string[] = []
	let depth = 0
	let start = 0
	let inLineComment = false

	const pushStatement = (end: number) => {
		// `$` as well as `\n`, so the LAST comment line counts as one too: `.trim()`
		// has already taken the newline off it, and without this a file that ends in
		// a comment block hands the runner a statement of pure prose to execute.
		const stmt = sql
			.slice(start, end)
			.trim()
			.replace(/^(--[^\n]*(?:\n\s*|$))+/, '')
			.trim()
		if (stmt) statements.push(stmt)
	}

	for (let i = 0; i < sql.length; i++) {
		// Skip `--` line comments entirely: their prose must never affect BEGIN/END
		// depth or statement splitting. Otherwise a stray word ("backend", "append")
		// or a `;` inside a comment would merge or mis-split real statements.
		if (inLineComment) {
			if (sql[i] === '\n') inLineComment = false
			continue
		}
		if (sql[i] === '-' && sql[i + 1] === '-') {
			inLineComment = true
			continue
		}
		// Only treat BEGIN/END as trigger-body tokens at a word boundary — never
		// inside an identifier (`append_log`) or a word (`backend`, `sender`).
		const atWordStart = i === 0 || !/\w/.test(sql[i - 1])
		if (atWordStart) {
			const word = sql.slice(i).match(/^(BEGIN|END)\b/i)
			if (word) {
				if (word[1].toUpperCase() === 'BEGIN') depth++
				else depth = Math.max(0, depth - 1)
			}
		}
		if (sql[i] === ';' && depth === 0) {
			pushStatement(i)
			start = i + 1
		}
	}
	pushStatement(sql.length)

	return statements.filter(Boolean)
}

/**
 * A synchronous SQLite seam for the migration runner. Synchronous ON PURPOSE: the
 * only way to get a genuinely atomic transaction on a SQLite-backed Durable Object
 * is `storage.transactionSync`, which requires a synchronous body (an async body
 * would let the transaction commit before the awaited statements run). `bun`/`node`
 * satisfy it with a synchronous `BEGIN`/`COMMIT`.
 */
export interface SyncMigrator {
	exec(sql: string, args?: SqlValue[]): void
	query(sql: string): Array<Record<string, unknown>>
	/** Run `fn` as ONE atomic transaction; roll back wholesale if it throws. */
	transactionSync(fn: () => void): void
}

/**
 * Apply pending migrations, each inside `transactionSync` so its statements AND its
 * `schema_migrations` record commit together. Otherwise an interrupt after a
 * committed-but-unrecorded step (e.g. an `ALTER TABLE ADD COLUMN`) re-runs the step
 * on the next startup, fails as a duplicate, and blocks every later migration.
 */
export function migrateSync(
	db: SyncMigrator,
	entries: Array<{ version: number; sql: string }>
): void {
	db.exec(
		`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`
	)
	const [row] = db.query('SELECT MAX(version) AS max_version FROM schema_migrations')
	const currentVersion = Number((row?.max_version as number | null | undefined) ?? 0)

	for (const entry of entries) {
		if (entry.version <= currentVersion) continue
		db.transactionSync(() => {
			for (const stmt of parseSqlStatements(entry.sql)) db.exec(stmt)
			db.exec(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))`, [
				entry.version
			])
		})
	}
}

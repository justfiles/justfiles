import type { DbAdapter } from '../db'

export function parseSqlStatements(sql: string): string[] {
	const statements: string[] = []
	let depth = 0
	let start = 0
	let inLineComment = false

	const pushStatement = (end: number) => {
		const stmt = sql
			.slice(start, end)
			.trim()
			.replace(/^(--[^\n]*\n\s*)+/, '')
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

export async function migrateFromEntries(
	adapter: DbAdapter,
	entries: Array<{ version: number; sql: string }>
): Promise<void> {
	await adapter.run(
		`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`
	)

	const [row] = await adapter.query<{ max_version: number }>(
		'SELECT MAX(version) AS max_version FROM schema_migrations'
	)
	const currentVersion = Number(row?.max_version ?? 0)

	for (const entry of entries) {
		if (entry.version <= currentVersion) continue
		// Apply the statements AND record the version in ONE transaction, so an interrupted
		// migration rolls back wholesale. Otherwise a committed-but-unrecorded step (e.g. an
		// `ALTER TABLE ADD COLUMN`) re-runs on the next startup, fails as a duplicate, and
		// blocks every later migration. (On the DO, `transaction` is the implicit per-event
		// commit; on bun/node it is a real BEGIN/COMMIT.)
		await adapter.transaction(async (tx) => {
			for (const stmt of parseSqlStatements(entry.sql)) {
				await tx.run(stmt)
			}
			await tx.run(
				`INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))`,
				[entry.version]
			)
		})
	}
}

import type { DbAdapter } from '../db'

export function parseSqlStatements(sql: string): string[] {
	const statements: string[] = []
	let depth = 0
	let start = 0

	for (let i = 0; i < sql.length; i++) {
		const word = sql.slice(i).match(/^(BEGIN|END)\b/i)
		if (word) {
			if (word[1].toUpperCase() === 'BEGIN') depth++
			else depth--
		}
		if (sql[i] === ';' && depth === 0) {
			const stmt = sql
				.slice(start, i)
				.trim()
				.replace(/^(--[^\n]*\n\s*)+/, '')
				.trim()
			if (stmt) statements.push(stmt)
			start = i + 1
		}
	}

	const last = sql
		.slice(start)
		.trim()
		.replace(/^(--[^\n]*\n\s*)+/, '')
		.trim()
	if (last) statements.push(last)

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
		for (const stmt of parseSqlStatements(entry.sql)) {
			await adapter.run(stmt)
		}
		await adapter.run(
			`INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))`,
			[entry.version]
		)
	}
}

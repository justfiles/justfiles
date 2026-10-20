import type { StateDatabase } from './types.ts'

// The state database holds one generation of pi's tables at a time, each under its own
// prefix; generation 0 is pi's unprefixed tables, as the first ghosts wrote them. Rotating
// moves to a fresh generation and drops the old one, which is what bounds the file: pi keeps
// every entry and task it ever stored, so nothing short of new tables shrinks it.

const META = 'ghost_state'

/** pi's table prefix for `generation`. */
export function prefixOf(generation: number): string | undefined {
	return generation === 0 ? undefined : `g${generation}_`
}

/**
 * The generation in use, 0 for a database that has never rotated, and the day the night's
 * consolidation started at when the rotation left the one before.
 */
export async function currentGeneration(
	db: StateDatabase
): Promise<{ generation: number; from?: string }> {
	await db.exec(
		`CREATE TABLE IF NOT EXISTS ${META} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), generation INTEGER NOT NULL, consolidate_from TEXT)`
	)
	const row = await db.get<{ generation: number; consolidate_from: string | null }>(
		`SELECT generation, consolidate_from FROM ${META}`
	)
	const generation = Number(row?.generation ?? 0)
	return row?.consolidate_from == null ? { generation } : { generation, from: row.consolidate_from }
}

/**
 * Make `generation` the one in use, keeping `from` for its consolidation, then drop every
 * other table and give their space back.
 */
export async function useGeneration(
	db: StateDatabase,
	generation: number,
	from: string | undefined
): Promise<void> {
	await db.run(
		`INSERT INTO ${META} (singleton, generation, consolidate_from) VALUES (1, ?, ?) ON CONFLICT (singleton) DO UPDATE SET generation = excluded.generation, consolidate_from = excluded.consolidate_from`,
		generation,
		from ?? null
	)
	await dropOtherGenerations(db, generation)
}

/** Drop the tables of every generation but `generation`; the ghost owns the whole database. */
export async function dropOtherGenerations(db: StateDatabase, generation: number): Promise<void> {
	const prefix = prefixOf(generation)
	if (prefix === undefined) return
	const tables = await db.all<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
	)
	const old = tables.filter(({ name }) => name !== META && !name.startsWith(prefix))
	if (old.length === 0) return
	for (const { name } of old) await db.exec(`DROP TABLE "${name}"`)
	await db.exec('VACUUM')
}

/** Bytes the database holds, free pages left out. */
export async function liveBytes(db: StateDatabase): Promise<number> {
	const pragma = async (name: string) =>
		Number(Object.values((await db.get<Record<string, number>>(`PRAGMA ${name}`)) ?? {})[0] ?? 0)
	return (
		((await pragma('page_count')) - (await pragma('freelist_count'))) * (await pragma('page_size'))
	)
}

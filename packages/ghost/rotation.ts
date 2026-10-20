import type { Settled, StateDatabase } from './types.ts'

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
 * What a generation hands the next: the day its consolidation was to start the next night at;
 * how its latest asks settled, so a retry of one is answered instead of asked again; and the
 * entry ids used so far, so the transcript mirror's ids keep rising.
 */
export interface Carried {
	from?: string
	asked?: Record<string, Settled>
	idsBefore?: number
}

/** The generation in use, 0 for a database that has never rotated, and what it was handed. */
export async function currentGeneration(
	db: StateDatabase
): Promise<{ generation: number; carried: Carried }> {
	await db.exec(
		`CREATE TABLE IF NOT EXISTS ${META} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), generation INTEGER NOT NULL, carried TEXT NOT NULL)`
	)
	const row = await db.get<{ generation: number; carried: string }>(
		`SELECT generation, carried FROM ${META}`
	)
	return row === undefined
		? { generation: 0, carried: {} }
		: { generation: Number(row.generation), carried: JSON.parse(row.carried) }
}

/**
 * Make `generation` the one in use, handed `carried`, then drop every other table and give
 * their space back.
 */
export async function useGeneration(
	db: StateDatabase,
	generation: number,
	carried: Carried
): Promise<void> {
	await db.run(
		`INSERT INTO ${META} (singleton, generation, carried) VALUES (1, ?, ?) ON CONFLICT (singleton) DO UPDATE SET generation = excluded.generation, carried = excluded.carried`,
		generation,
		JSON.stringify(carried)
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

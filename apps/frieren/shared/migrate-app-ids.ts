// One-off, removable id migration (Kodama rebrand). Moves a user's first-party
// app layout from the retired `computer.spud.*` ids to `app.justfiles.frieren.*`
// inside their synced Volume. Pure over a `Volume` so the whole decision surface
// is unit-testable; the DO wraps it as the `migrateAppIdsV1` RPC (frieren.ts) and
// the client boot runs it before seeding built-ins (runtime.ts).
//
// Safety contract:
// - Explicit old->new map. NEVER prefix-substitute. If production data carries
//   older `app.spud.*` / `app.frieren.*` ids, add each EXACT alias below.
// - A dry run mutates nothing and reports sources, conflicts, counts.
// - A conflict (old AND new both present for any path) aborts the WHOLE run
//   before any mutation — nothing is overwritten; a human resolves it.
// - Moves are atomic `rename`s (reversible), and the only content edits are the
//   quoted-id rewrites of `manifest.json` / `os-state.json`. Recovery is the
//   Durable Object's automatic 30-day SQLite PITR (the RPC records the bookmark);
//   no in-volume backup is kept.
// This file and its call sites are deleted once the migration is done.
import type { Volume } from '@justfiles/fs'

export const APP_ID_MIGRATION_V1: ReadonlyArray<readonly [string, string]> = [
	['computer.spud.code', 'app.justfiles.frieren.code'],
	['computer.spud.files', 'app.justfiles.frieren.files'],
	['computer.spud.notes', 'app.justfiles.frieren.notes'],
	['computer.spud.paint', 'app.justfiles.frieren.paint'],
	['computer.spud.settings', 'app.justfiles.frieren.settings'],
	['computer.spud.crossword', 'app.justfiles.frieren.crossword'],
	['computer.spud.doom', 'app.justfiles.frieren.doom'],
	['computer.spud.draw', 'app.justfiles.frieren.draw'],
	['computer.spud.pixel', 'app.justfiles.frieren.pixel']
]

const OS_STATE_PATH = '/system/os-state.json'

export interface AppIdMigrationEntry {
	oldId: string
	newId: string
	/** Existing source paths found for this app (subset of applications/state/data). */
	sources: string[]
	/** Destination paths that already exist while the source also does — blocks the move. */
	conflicts: string[]
	/** Destination paths actually moved (empty on a dry run or a skipped app). */
	moved: string[]
}

export interface AppIdMigrationResult {
	dryRun: boolean
	/** True if ANY app has a conflict; when true nothing was mutated. */
	conflict: boolean
	/** Count of quoted id tokens rewritten in os-state.json. */
	osStateRewrites: number
	entries: AppIdMigrationEntry[]
}

// The three per-app storage roots the layout keys by app id.
function appPaths(id: string): [applications: string, state: string, data: string] {
	return [`/applications/${id}`, `/state/${id}.json`, `/data/${id}`]
}

// Replace whole quoted id tokens (`"<oldId>"`). The surrounding quotes bound the
// match, so a longer id that merely starts with `oldId` never partial-matches,
// and it rewrites ids wherever they appear in the JSON — values AND object keys
// (windows, focus, ordering, placements, maps) — without knowing the shape.
function rewriteIdTokens(
	text: string,
	pairs: ReadonlyArray<readonly [string, string]>
): { text: string; count: number } {
	let out = text
	let count = 0
	for (const [oldId, newId] of pairs) {
		const parts = out.split(`"${oldId}"`)
		if (parts.length > 1) {
			count += parts.length - 1
			out = parts.join(`"${newId}"`)
		}
	}
	return { text: out, count }
}

async function readText(vol: Volume, path: string): Promise<string> {
	return new TextDecoder().decode(await vol.readFile(path))
}

async function writeText(vol: Volume, path: string, text: string): Promise<void> {
	await vol.writeFile(path, new TextEncoder().encode(text))
}

export async function runAppIdMigrationV1(
	vol: Volume,
	opts: { dryRun: boolean }
): Promise<AppIdMigrationResult> {
	const entries: AppIdMigrationEntry[] = []

	// Pass 1 — discover sources and conflicts for every mapping. No mutation.
	for (const [oldId, newId] of APP_ID_MIGRATION_V1) {
		const olds = appPaths(oldId)
		const news = appPaths(newId)
		const sources: string[] = []
		const conflicts: string[] = []
		for (let i = 0; i < olds.length; i++) {
			const hasOld = await vol.exists(olds[i])
			if (!hasOld) continue
			sources.push(olds[i])
			// Both present -> preserve both; do not overwrite.
			if (await vol.exists(news[i])) conflicts.push(news[i])
		}
		entries.push({ oldId, newId, sources, conflicts, moved: [] })
	}

	const conflict = entries.some((e) => e.conflicts.length > 0)
	// A dry run, or ANY conflict, reports and mutates nothing.
	if (opts.dryRun || conflict) {
		return { dryRun: opts.dryRun, conflict, osStateRewrites: 0, entries }
	}

	// Pass 2 — move each app's paths (atomic rename), then rewrite the moved
	// manifest's id.
	for (const entry of entries) {
		if (entry.sources.length === 0) continue
		const olds = appPaths(entry.oldId)
		const news = appPaths(entry.newId)
		for (let i = 0; i < olds.length; i++) {
			if (!(await vol.exists(olds[i]))) continue
			await vol.rename(olds[i], news[i])
			entry.moved.push(news[i])
		}
		const manifestPath = `/applications/${entry.newId}/manifest.json`
		if (await vol.exists(manifestPath)) {
			const rewritten = rewriteIdTokens(await readText(vol, manifestPath), [
				[entry.oldId, entry.newId]
			])
			await writeText(vol, manifestPath, rewritten.text)
		}
	}

	// Pass 3 — rewrite every id reference in os-state.json (windows, focus,
	// ordering, placements, maps) in one pass. Only write when it actually holds a
	// legacy id, so an already-migrated volume is a true no-op.
	let osStateRewrites = 0
	if (await vol.exists(OS_STATE_PATH)) {
		const rewritten = rewriteIdTokens(await readText(vol, OS_STATE_PATH), APP_ID_MIGRATION_V1)
		if (rewritten.count > 0) {
			await writeText(vol, OS_STATE_PATH, rewritten.text)
			osStateRewrites = rewritten.count
		}
	}

	return { dryRun: false, conflict: false, osStateRewrites, entries }
}

// Client entry: run the migration exactly once per volume within this tab. The
// boot flow calls this after the initial sync settles and before built-ins seed,
// so only legacy ids exist and the move is clean. Idempotent across boots/tabs
// (a no-op once no legacy ids remain); the per-volume memo just collapses a dev
// remount or a structural-watch re-fire in the SAME tab onto one run.
const clientRuns = new WeakMap<Volume, Promise<AppIdMigrationResult>>()
export function migrateAppIdsOnce(vol: Volume): Promise<AppIdMigrationResult> {
	let run = clientRuns.get(vol)
	if (!run) {
		run = runAppIdMigrationV1(vol, { dryRun: false })
		clientRuns.set(vol, run)
	}
	return run
}

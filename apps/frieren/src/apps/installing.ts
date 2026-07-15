import type { Volume } from '@justfiles/fs'

// Background app installs. The launcher shows an "installing" tile (a spinner,
// not launchable) while the bytes download, so the desktop stays usable instead
// of blocking on the consent sheet.
//
// Durability lives in the fs (an intent marker per install), mirrored into this
// in-memory store — the fast feed the launcher tiles subscribe to. Markers sit
// under `/.state` (local-only, never synced), so an install intent is
// device-local: a reload on THIS device resumes it; other devices are untouched.
export interface InstallingApp {
	id: string
	name: string
	iconUrl?: string
}

const MARKER_DIR = '/.state/installing'

function markerPath(id: string): string {
	return `${MARKER_DIR}/${encodeURIComponent(id)}.json`
}

let installing: InstallingApp[] = []
const listeners = new Set<(apps: InstallingApp[]) => void>()

function emit(): void {
	for (const fn of listeners) fn(installing)
}

export function subscribeInstalling(fn: (apps: InstallingApp[]) => void): () => void {
	fn(installing)
	listeners.add(fn)
	return () => {
		listeners.delete(fn)
	}
}

export function getInstalling(): InstallingApp[] {
	return installing
}

// Mark an install as started: persist the intent marker, then show its tile.
export async function beginInstall(fs: Volume, app: InstallingApp): Promise<void> {
	await fs.mkdir(MARKER_DIR, { recursive: true })
	await fs.writeFile(markerPath(app.id), new TextEncoder().encode(JSON.stringify(app)))
	if (!installing.some((a) => a.id === app.id)) {
		installing = [...installing, app]
		emit()
	}
}

// Mark an install as finished (success OR terminal failure): drop the marker and
// the tile. Idempotent.
export async function endInstall(fs: Volume, id: string): Promise<void> {
	await fs.rm(markerPath(id), { force: true })
	const next = installing.filter((a) => a.id !== id)
	if (next.length !== installing.length) {
		installing = next
		emit()
	}
}

// The install intents left over from a previous session (boot resume).
export async function readInstallMarkers(fs: Volume): Promise<InstallingApp[]> {
	if (!(await fs.exists(MARKER_DIR))) return []
	const out: InstallingApp[] = []
	for (const { name } of await fs.readdir(MARKER_DIR)) {
		try {
			out.push(JSON.parse(new TextDecoder().decode(await fs.readFile(`${MARKER_DIR}/${name}`))))
		} catch {}
	}
	return out
}

// Seed the in-memory tiles from markers at boot, before the resumed installs land.
export function seedInstalling(apps: InstallingApp[]): void {
	installing = apps
	emit()
}

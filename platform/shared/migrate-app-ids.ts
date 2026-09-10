interface MigrationVolume {
	rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>
	exists(path: string): Promise<boolean>
	readFile(path: string): Promise<Uint8Array>
	rename(oldPath: string, newPath: string): Promise<void>
	writeFile(path: string, data: Uint8Array): Promise<void>
}

// One-off migration from the pre-catalog first-party ids to the publisher-scoped ids.
// Keep the map exact: only apps owned by JustFiles move.
export const FIRST_PARTY_APP_ID_RENAMES: ReadonlyArray<readonly [string, string]> = [
	['app.justfiles.frieren.code', 'justfiles.code'],
	['app.justfiles.frieren.crossword', 'justfiles.crossword'],
	['app.justfiles.frieren.dictionary', 'justfiles.dictionary'],
	['app.justfiles.frieren.doom', 'justfiles.doom'],
	['app.justfiles.frieren.draw', 'justfiles.draw'],
	['app.justfiles.frieren.files', 'justfiles.files'],
	['app.justfiles.frieren.notes', 'justfiles.notes'],
	['app.justfiles.frieren.paint', 'justfiles.paint'],
	['app.justfiles.frieren.pixel', 'justfiles.pixel']
]

function appPaths(id: string): [string, string, string] {
	return [`/applications/${id}`, `/state/${id}.json`, `/data/${id}`]
}

function rewriteIds(text: string): string {
	let next = text
	for (const [oldId, newId] of FIRST_PARTY_APP_ID_RENAMES) {
		next = next.split(`"${oldId}"`).join(`"${newId}"`)
	}
	return next
}

export const RETIRED_SETTINGS_IDS = new Set([
	'app.justfiles.frieren.settings',
	'justfiles.settings'
])

const runs = new WeakMap<MigrationVolume, Promise<boolean>>()

// Returns false when an old and new path both exist. In that case, it changes nothing.
// A run that stops on an I/O error is safe to retry: each path is an atomic rename, and
// the manifest and OS state rewrites are idempotent.
export function migrateFirstPartyAppIds(fs: MigrationVolume): Promise<boolean> {
	let run = runs.get(fs)
	if (!run) {
		run = migrate(fs)
		runs.set(fs, run)
	}
	return run
}

async function migrate(fs: MigrationVolume): Promise<boolean> {
	for (const id of RETIRED_SETTINGS_IDS) {
		if (await fs.exists(`/applications/${id}`))
			await fs.rm(`/applications/${id}`, { recursive: true, force: true })
	}
	for (const [oldId, newId] of FIRST_PARTY_APP_ID_RENAMES) {
		const oldPaths = appPaths(oldId)
		const newPaths = appPaths(newId)
		for (let i = 0; i < oldPaths.length; i++) {
			if ((await fs.exists(oldPaths[i])) && (await fs.exists(newPaths[i]))) return false
		}
	}

	for (const [oldId, newId] of FIRST_PARTY_APP_ID_RENAMES) {
		const oldPaths = appPaths(oldId)
		const newPaths = appPaths(newId)
		for (let i = 0; i < oldPaths.length; i++) {
			if (await fs.exists(oldPaths[i])) await fs.rename(oldPaths[i], newPaths[i])
		}

		const manifestPath = `/applications/${newId}/manifest.json`
		if (await fs.exists(manifestPath)) {
			const text = new TextDecoder().decode(await fs.readFile(manifestPath))
			const next = rewriteIds(text)
			if (next !== text) await fs.writeFile(manifestPath, new TextEncoder().encode(next))
		}
	}

	const osStatePath = '/system/os-state.json'
	if (await fs.exists(osStatePath)) {
		const text = new TextDecoder().decode(await fs.readFile(osStatePath))
		const next = rewriteIds(text)
		if (next !== text) await fs.writeFile(osStatePath, new TextEncoder().encode(next))
	}
	return true
}

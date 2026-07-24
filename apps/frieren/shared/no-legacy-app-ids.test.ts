import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'vitest'

// Guard: the live web product (apps/frieren + shared packages) must not carry a
// retired first-party id prefix. After the Kodama rename the only legitimate
// homes for these tokens are the migration map and the indexer's reserved list,
// so they are exempt; everything else is a leak (a new app, allowlist, or copy
// that reintroduced a dead id). apps/spud-mac is out of scope (local-test only,
// intentionally left on legacy ids) and test fixtures / docs are not scanned.
const ROOT = process.cwd()
const SCAN_DIRS = ['apps/frieren', 'packages']
const LEGACY_ID = /(computer\.spud\.|app\.spud\.|app\.frieren\.)/

const EXEMPT_FILES = new Set([
	'apps/frieren/shared/migrate-app-ids.ts', // the explicit old->new migration map
	'apps/frieren/worker/appstore/indexer.ts' // keeps retired prefixes reserved (anti-squat)
])
const SKIP_DIRS = new Set(['node_modules', 'dist'])

function isScannable(rel: string): boolean {
	if (!/\.tsx?$/.test(rel)) return false
	if (/\.test\.tsx?$/.test(rel) || /\.bun\.test\.ts$/.test(rel)) return false
	return !EXEMPT_FILES.has(rel)
}

function collect(dir: string, out: string[]): void {
	for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
		const rel = join(dir, entry.name)
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) collect(rel, out)
		} else if (isScannable(rel)) {
			out.push(rel)
		}
	}
}

describe('no retired first-party ids in the live product', () => {
	test('computer.spud.* / app.spud.* / app.frieren.* only survive in exempt files', () => {
		const files: string[] = []
		for (const dir of SCAN_DIRS) collect(dir, files)
		const offenders = files.filter((f) => LEGACY_ID.test(readFileSync(join(ROOT, f), 'utf8')))
		expect(offenders.map((f) => relative(ROOT, f))).toEqual([])
	})
})

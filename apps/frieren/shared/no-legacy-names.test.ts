import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

// Guard: the retired public brand ("spud", in any casing) and the retired first-party id
// prefixes must not come back. Both were fully renamed — the brand to Kodama (public copy)
// / frieren (internal ids), the ids to `app.justfiles.frieren.*` — so any new occurrence in
// code or config is a leak: a new app, an allowlist, a copy string, or a config key that
// reintroduced a dead name.
//
// Scope: source + config across the whole product. Markdown/HTML are not scanned (CHANGELOGs
// and historical design/plan docs legitimately record the old name), and neither are tests
// (the indexer's reservation tests need legacy fixtures).
const ROOT = join(import.meta.dirname, '..', '..', '..')
const SCAN_DIRS = ['apps', 'packages']
const SCAN_ROOT_FILES = ['turbo.json', 'vitest.config.ts', 'package.json', 'pnpm-workspace.yaml']
const RETIRED = /(spud|computer\.spud\.|app\.spud\.|app\.frieren\.)/i
const SCAN_EXT = /\.(tsx?|jsx?|mjs|cjs|json|jsonc|swift|sh|css|yaml|yml|plist)$/

// The only legitimate homes for a retired name — each one keeps it on purpose.
const EXEMPT_FILES = new Set([
	'apps/frieren/worker/appstore/denylist.ts', // retired npm names, banned from the store
	'apps/frieren/worker/appstore/feed.ts', // still searches the retired npm keyword
	'apps/frieren/worker/appstore/indexer.ts' // keeps retired id prefixes reserved (anti-squat)
])
// The built-in avatar art, baked to base64 (`pnpm run avatars`): 200 KB of the base64
// alphabet spells words, and none of them are a name anyone wrote.
const BAKED_ART = /^packages\/agent\/avatars(\.ts$|\/)/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.wrangler', 'out'])

function isScannable(rel: string): boolean {
	if (!SCAN_EXT.test(rel)) return false
	if (/\.test\.(tsx?|jsx?)$/.test(rel) || /\.bun\.test\.ts$/.test(rel)) return false
	return !EXEMPT_FILES.has(rel) && !BAKED_ART.test(rel)
}

function collect(dir: string, out: string[]): void {
	for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
		const rel = `${dir}/${entry.name}`
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) collect(rel, out)
		} else if (isScannable(rel)) {
			out.push(rel)
		}
	}
}

describe('no retired names in the product', () => {
	test('the retired brand + id prefixes only survive in exempt files', () => {
		const files = SCAN_ROOT_FILES.filter((f) => statSync(join(ROOT, f), { throwIfNoEntry: false }))
		for (const dir of SCAN_DIRS) collect(dir, files)
		const offenders = files.filter((f) => RETIRED.test(readFileSync(join(ROOT, f), 'utf8')))
		expect(offenders).toEqual([])
	})
})

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

// Guard: the retired public brands ("spud" and "kodama", in any casing) and the retired
// first-party id prefixes must not come back. Public copy is now Just Computer, internal ids
// stay brand-free, and first-party app ids use `justfiles.*` — so any new occurrence in
// code or config is a leak: a new app, an allowlist, a copy string, or a config key that
// reintroduced a dead name.
//
// Scope: source + config across the whole product. Markdown/HTML are not scanned (CHANGELOGs
// and historical design/plan docs legitimately record the old name), and neither are tests
// (the indexer's reservation tests need legacy fixtures).
const ROOT = join(import.meta.dirname, '..', '..', '..')
const SCAN_DIRS = ['platform', 'apps/crossword', 'apps/doom', 'apps/pixel', 'apps/read', 'packages']
const SCAN_ROOT_FILES = ['turbo.json', 'vitest.config.ts', 'package.json', 'pnpm-workspace.yaml']
const RETIRED =
	/(spud|kodama|computer\.spud\.|app\.spud\.|app\.frieren\.|app\.justfiles\.frieren\.(?!host\b|ext\.))/i
const SCAN_EXT = /\.(tsx?|jsx?|mjs|cjs|json|jsonc|swift|sh|css|yaml|yml|plist)$/

// These values predate the public rebrand but are persisted integration ids.
const STABLE_LEGACY = new Map<string, RegExp>([
	['platform/mac/daemon/fs.ts', /KODAMA_STORE_ORIGIN/g],
	['platform/mac/daemon/identity.ts', /kodama-oauth|KODAMA_CLERK_(?:FAPI|CLIENT_ID)/g],
	['platform/mac/daemon/keychain.ts', /app\.justfiles\.kodama/g],
	['platform/mac/daemon/platform-ai.ts', /const ID = 'kodama'/g]
])

// The built-in avatar art, baked to base64 (`pnpm run avatars`): 200 KB of the base64
// alphabet spells words, and none of them are a name anyone wrote.
const BAKED_ART = /^packages\/agent\/avatars(\.ts$|\/)/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.wrangler', 'out'])
const EXEMPT_FILES = new Set([
	'platform/shared/migrate-app-ids.ts',
	'platform/mac/daemon/materialize.ts',
	'platform/mac/native/Sources/shell/Catalog.swift'
])

function isScannable(rel: string): boolean {
	if (!SCAN_EXT.test(rel)) return false
	if (/\.test\.(tsx?|jsx?)$/.test(rel) || /\.bun\.test\.ts$/.test(rel)) return false
	return !BAKED_ART.test(rel) && !EXEMPT_FILES.has(rel)
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
		const offenders = files.filter((f) => {
			const content = readFileSync(join(ROOT, f), 'utf8').replace(STABLE_LEGACY.get(f) ?? /$^/, '')
			return RETIRED.test(content)
		})
		expect(offenders).toEqual([])
	})
})

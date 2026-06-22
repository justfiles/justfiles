// Step 1 guard: the host builds ONE SDK (`buildRuntime`) served at `/vendor/<spec>.js`
// and the externals constant is the single source both compile paths + the importmap
// read. These lock the two invariants Step 1 introduces: vendor URLs mirror the
// specifier (no mangling), and every reducer-reachable SDK module stays react-free (a
// reducer worker has no importmap to resolve a bare `react`).

import { expect, test } from 'vitest'
import { buildRuntime } from './devkit-runtime.ts'
import {
	externals,
	reactExternals,
	resolveSdkExternals,
	sdkExternals,
	sentinelizeReducer,
	vendorUrl
} from './sdk-externals.ts'

const REACT_FAMILY = /^react(-dom)?(\/|$)/
const importSpecifiers = (source: string): string[] =>
	[...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string)

test('externals = react family + every SDK spec, deduped, no react in the SDK list', () => {
	expect(externals).toEqual([...reactExternals, ...sdkExternals.map((s) => s.spec)])
	expect(new Set(externals).size).toBe(externals.length)
	expect(sdkExternals.some((s) => REACT_FAMILY.test(s.spec))).toBe(false)
})

test('vendor URLs mirror the specifier (no hyphen-mangling)', () => {
	expect(vendorUrl('@justfiles/app')).toBe('/vendor/@justfiles/app.js')
	expect(vendorUrl('@justfiles/app/capabilities/volume')).toBe(
		'/vendor/@justfiles/app/capabilities/volume.js'
	)
	expect(vendorUrl('valibot')).toBe('/vendor/valibot.js')
})

test('buildRuntime builds every SDK spec and keeps reducer-reachable modules react-free', async () => {
	const runtime = await buildRuntime()
	expect(Object.keys(runtime).sort()).toEqual(sdkExternals.map((s) => s.spec).sort())
	for (const { spec, reducer } of sdkExternals) {
		if (!reducer) continue
		const react = importSpecifiers(runtime[spec] as string).filter((d) => REACT_FAMILY.test(d))
		expect(react, `reducer-reachable ${spec} must import no React`).toEqual([])
	}
}, 30_000)

// The rewrites are lexer-based, not regex: they must rewrite REAL imports but never an
// import-like substring inside a STRING LITERAL. Code embeds a starter template
// (`import { defineApp } from '@justfiles/app'`) as a string in its reducer; a regex
// sentinelizer corrupted that string, which broke every project created from the starter.
test('sentinelizeReducer rewrites real SDK imports but never a string-literal lookalike', () => {
	const code = [
		`import{defineApp as L}from"@justfiles/app";`,
		`const STARTER="import { defineApp } from '@justfiles/app'";`,
		`const x=await import("valibot");`,
		`import{x}from"./local";`
	].join('')
	const out = sentinelizeReducer(code)
	expect(out).toContain('from"justfiles-sdk:@justfiles/app"') // real import sentinelized
	expect(out).toContain('import("justfiles-sdk:valibot")') // real dynamic import sentinelized
	expect(out).toContain(`"import { defineApp } from '@justfiles/app'"`) // string literal untouched
	expect(out).toContain('from"./local"') // relative import untouched
})

test('resolveSdkExternals round-trips sentinelizeReducer for allowlisted specs', () => {
	const code = `import{a}from"@justfiles/app";const d=await import("valibot");import{b}from"./x"`
	const resolved = resolveSdkExternals(sentinelizeReducer(code), (spec) => `/vendor/${spec}.js`)
	expect(resolved).toContain('from"/vendor/@justfiles/app.js"')
	expect(resolved).toContain('import("/vendor/valibot.js")')
	expect(resolved).toContain('from"./x"')
})

test('resolveSdkExternals ignores a bogus (non-allowlisted) sentinel', () => {
	const code = `const e=await import("justfiles-sdk:../../evil");import{a}from"justfiles-sdk:@justfiles/app"`
	const out = resolveSdkExternals(code, (spec) => `/vendor/${spec}.js`)
	expect(out).toContain('import("justfiles-sdk:../../evil")') // left untouched, no fetch URL
	expect(out).toContain('from"/vendor/@justfiles/app.js"') // allowlisted one resolved
})

test('both rewrites leave a bundle with no matching imports byte-identical', () => {
	const code = `import{x}from"./local";const s="import a from '@justfiles/app'";export const y=1`
	expect(sentinelizeReducer(code)).toBe(code)
	expect(resolveSdkExternals(code, () => 'unused')).toBe(code)
})

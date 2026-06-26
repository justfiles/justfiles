// The host builds ONE SDK runtime (`buildRuntime`) for devkit to bundle into draft
// outputs. These lock the invariants: Vite app GUI externals are React-only, vendor URLs
// mirror the specifier (no mangling), and every reducer-reachable SDK module stays
// react-free (a reducer worker has no importmap to resolve a bare `react`).

import { expect, test } from 'vitest'
import { buildRuntime } from './capabilities/devkit/devkit-runtime.ts'
import { externals, reactExternals, sdkExternals, vendorUrl } from './sdk-externals.ts'

const REACT_FAMILY = /^react(-dom)?(\/|$)/
const importSpecifiers = (source: string): string[] =>
	[...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string)

test('Vite app GUI externals are React-only; SDK specs are runtime inputs', () => {
	expect(externals).toEqual(reactExternals)
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

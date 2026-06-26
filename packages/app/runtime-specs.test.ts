// The host builds ONE SDK runtime (`buildRuntime`) for devkit to bundle into draft
// outputs. These lock the invariants: app GUI externals are React-only, and every
// reducer-reachable SDK module stays react-free (a reducer worker has no importmap to
// resolve a bare `react`).

import { expect, test } from 'vitest'
import { buildRuntime } from './capabilities/devkit/devkit-runtime.ts'
import { reactExternals, sdkRuntimeSpecs } from './runtime-specs.ts'

const REACT_FAMILY = /^react(-dom)?(\/|$)/
const importSpecifiers = (source: string): string[] =>
	[...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string)

test('React externals are unique and not SDK runtime specs', () => {
	expect(new Set(reactExternals).size).toBe(reactExternals.length)
	expect(sdkRuntimeSpecs.some((s) => REACT_FAMILY.test(s.spec))).toBe(false)
})

test('buildRuntime builds every SDK spec and keeps reducer-reachable modules react-free', async () => {
	const runtime = await buildRuntime()
	expect(Object.keys(runtime).sort()).toEqual(sdkRuntimeSpecs.map((s) => s.spec).sort())
	for (const { spec, reducer } of sdkRuntimeSpecs) {
		if (!reducer) continue
		const react = importSpecifiers(runtime[spec] as string).filter((d) => REACT_FAMILY.test(d))
		expect(react, `reducer-reachable ${spec} must import no React`).toEqual([])
	}
}, 30_000)

// The host builds ONE runtime map (`buildRuntime`) for devkit to bundle into draft
// outputs. These lock the invariants: it covers every spec devkit can resolve (the SDK
// plus React), React's modules reach each other through the map rather than inlining a
// second copy, and every reducer-reachable SDK module stays react-free (the reducer runs
// headless in a Worker with no document).

import { expect, test } from 'vitest'
import { buildRuntime } from './capabilities/devkit/devkit-runtime.ts'
import { reactSpecs, sdkRuntimeSpecs } from './runtime-specs.ts'

const REACT_FAMILY = /^react(-dom)?(\/|$)/
const importSpecifiers = (source: string): string[] =>
	[...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string)
const requireSpecifiers = (source: string): string[] =>
	[...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\)/g)].map((m) => m[1] as string)

test('React specs are unique and not SDK runtime specs', () => {
	expect(new Set(reactSpecs).size).toBe(reactSpecs.length)
	expect(sdkRuntimeSpecs.some((s) => REACT_FAMILY.test(s.spec))).toBe(false)
})

test('buildRuntime covers every spec and keeps the reducer react-free', async () => {
	const runtime = await buildRuntime()
	expect(Object.keys(runtime).sort()).toEqual(
		[...sdkRuntimeSpecs.map((s) => s.spec), ...reactSpecs].sort()
	)
	for (const { spec, reducer } of sdkRuntimeSpecs) {
		if (!reducer) continue
		const react = importSpecifiers(runtime[spec] as string).filter((d) => REACT_FAMILY.test(d))
		expect(react, `reducer-reachable ${spec} must import no React`).toEqual([])
	}
	// A React module reaches its siblings by bare specifier, which resolves back through
	// this same map — so a draft links ONE React. `react-dom/client` is the one that
	// breaks if the exact-match externalisation slips: it would go hollow.
	for (const spec of reactSpecs) {
		const source = runtime[spec] as string
		for (const dep of requireSpecifiers(source))
			expect(reactSpecs, `${spec} requires an unresolvable "${dep}"`).toContain(dep)
	}
	expect((runtime['react-dom/client'] as string).length).toBeGreaterThan(100_000)
}, 60_000)

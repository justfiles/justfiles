// The host builds ONE runtime map (`buildRuntime`) for devkit to bundle into draft
// outputs. These lock the invariants: it covers exactly the specs devkit can resolve,
// it ships no UI framework, and every module in it is self-contained — nothing is
// external, so a draft is never left with a bare specifier to resolve at link time.

import { expect, test } from 'vitest'
import { buildRuntime } from './capabilities/devkit/devkit-runtime.ts'
import { sdkRuntimeSpecs } from './runtime-specs.ts'

const REACT_FAMILY = /^react(-dom)?(\/|$)/
const importSpecifiers = (source: string): string[] =>
	[...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string)

test('the spec list is unique', () => {
	expect(new Set(sdkRuntimeSpecs).size).toBe(sdkRuntimeSpecs.length)
})

// App Code is a built-in authoring tool, not an npm dev environment: a draft gets the
// platform SDK and writes its GUI as plain DOM through `defineGUI`. Shipping a
// framework here would put the platform back in the business of choosing one.
test('the sysroot ships no UI framework', () => {
	expect(sdkRuntimeSpecs.filter((spec) => REACT_FAMILY.test(spec))).toEqual([])
})

test('buildRuntime covers every spec and inlines everything it uses', async () => {
	const runtime = await buildRuntime()
	expect(Object.keys(runtime).sort()).toEqual([...sdkRuntimeSpecs].sort())
	// Nothing is external, so a bundled module has no import left to resolve. A
	// leftover bare specifier would surface as an unresolvable import in a draft.
	for (const spec of sdkRuntimeSpecs)
		expect(importSpecifiers(runtime[spec] as string), `${spec} must inline its deps`).toEqual([])
}, 60_000)

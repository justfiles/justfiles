// The host builds ONE runtime map (`buildRuntime`) for devkit to bundle into draft
// outputs. These lock the invariants: it covers exactly the specs devkit can resolve
// and ships no framework bytes. Only the optional React adapter keeps bare imports;
// the project's pinned import map resolves those when the adapter is used.

import { expect, test } from 'vitest'
import { buildRuntime } from './capabilities/devkit/devkit-runtime.ts'
import { sdkRuntimeSpecs } from './runtime-specs.ts'

const REACT_FAMILY = /^react(-dom)?(\/|$)/
const REACT_ADAPTER_IMPORTS = ['react', 'react-dom/client']
const importSpecifiers = (source: string): string[] =>
	[...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string)

test('the spec list is unique', () => {
	expect(new Set(sdkRuntimeSpecs).size).toBe(sdkRuntimeSpecs.length)
})

test('the sysroot lists no UI framework as a platform module', () => {
	expect(sdkRuntimeSpecs.filter((spec) => REACT_FAMILY.test(spec))).toEqual([])
})

test('buildRuntime covers every spec and leaves only adapter imports external', async () => {
	const runtime = await buildRuntime()
	expect(Object.keys(runtime).sort()).toEqual([...sdkRuntimeSpecs].sort())
	for (const spec of sdkRuntimeSpecs) {
		const expected = spec === '@justfiles/app/react' ? REACT_ADAPTER_IMPORTS : []
		expect(importSpecifiers(runtime[spec] as string).sort(), spec).toEqual(expected)
	}
}, 60_000)

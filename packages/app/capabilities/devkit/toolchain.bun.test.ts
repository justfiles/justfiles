// The Bun toolchain, run under `bun test` (needs `Bun.build` + `bun:test`) — the Bun
// half of the toolchain CI matrix. Mirrors `toolchain.test.ts`'s compile assertions and
// adds a shape diff against the esbuild toolchain (both run in one Bun process): same
// `app.js`/`gui.js` outputs, the system runtime injected, nothing external.
// Excluded from the node vitest run (see vitest.config.ts).

import { expect, test } from 'bun:test'
import * as esbuild from 'esbuild'
import { buildRuntime } from './devkit-runtime.ts'
import { type ImportGraph, type ResolvedImports, resolveImport } from './imports.ts'
import { bunCompile } from './toolchain.bun.ts'
import { esbuildCompile } from './toolchain.esbuild.ts'
import type { ProjectInput } from './toolchain.ts'

const APP = `import { defineApp } from '@justfiles/app'
import * as v from 'valibot'
export const app = defineApp({
	init: { count: 0 },
	update: (t) => ({
		increment: t.on(v.object({}), (state) => ({ count: state.count + 1 }))
	})
})`

// A framework-free GUI through `defineGUI`.
const GUI = `import { defineGUI } from '@justfiles/app/browser'
export const gui = defineGUI({
	mount(el, state) {
		el.textContent = String((state as { count?: number } | null)?.count ?? 0)
		return { update() {}, unmount() {} }
	}
})`

const project = (files: Record<string, string>, gui?: string): ProjectInput => ({
	files,
	entries: { app: 'app.ts', ...(gui ? { gui } : {}) },
	tsconfig: {}
})

const runtime = await buildRuntime()
// Every devkit output bundles the SDK: no external/sentinel SDK import survives — the
// source is inlined from the `runtime` map.
const bundlesSdk = (app: string) =>
	!/from\s*["']@justfiles\/app/.test(app) &&
	!/from\s*["']valibot["']/.test(app) &&
	!app.includes('justfiles-sdk:')

test('compile produces named outputs with no errors', async () => {
	const result = await bunCompile(project({ 'app.ts': APP, 'gui.ts': GUI }, 'gui.ts'), runtime)
	expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	expect(
		result.outputs
			.map((o) => o.path)
			.filter((p) => p.endsWith('.js'))
			.sort()
	).toEqual(['app.js', 'gui.js'])
	expect(bundlesSdk(result.outputs.find((o) => o.path === 'app.js')!.text)).toBe(true)
	expect(bundlesSdk(result.outputs.find((o) => o.path === 'gui.js')!.text)).toBe(true)
})

test('shape parity with the esbuild toolchain', async () => {
	const input = project({ 'app.ts': APP, 'gui.ts': GUI }, 'gui.ts')
	const es = await esbuildCompile(input, esbuild.build, runtime)
	const bun = await bunCompile(input, runtime)
	const names = (r: { outputs: { path: string }[] }) =>
		r.outputs
			.map((o) => o.path)
			.filter((p) => p.endsWith('.js'))
			.sort()
	expect(names(bun)).toEqual(names(es))
	expect(es.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	expect(bun.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	expect(bundlesSdk(es.outputs.find((o) => o.path === 'gui.js')!.text)).toBe(true)
	expect(bundlesSdk(bun.outputs.find((o) => o.path === 'gui.js')!.text)).toBe(true)
})

test('bundles the React GUI adapter against declared imports', async () => {
	const react = 'https://esm.sh/react@19.1.1/es2022/react.mjs'
	const reactDom = 'https://esm.sh/react-dom@19.1.1/es2022/client.mjs'
	const graph: ImportGraph = {
		code: { react, 'react-dom/client': reactDom },
		declarations: {},
		limits: { depth: 20, files: 100, fileBytes: 1_000, totalBytes: 2_000, timeoutMs: 100 }
	}
	const sources: Record<string, string> = {
		[react]:
			"export const createElement = (type, props) => ({ type, props, marker: 'react marker' })",
		[reactDom]:
			"export const createRoot = () => ({ render: () => 'react dom marker', unmount() {} })"
	}
	const imports: ResolvedImports = {
		...graph,
		load: async (url) => ({ url, text: sources[url] ?? '' }),
		resolve: (specifier, importer, kind) => resolveImport(graph, specifier, importer, kind),
		lock: () => ({ version: 1, redirects: {}, remote: {} }),
		diagnostics: []
	}
	const gui = `import { defineReactGUI } from '@justfiles/app/react'
export const gui = defineReactGUI(() => null)`
	const { outputs, diagnostics } = await bunCompile(
		project({ 'app.ts': APP, 'gui.ts': gui }, 'gui.ts'),
		runtime,
		imports
	)

	expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	const output = outputs.find((item) => item.path === 'gui.js')?.text ?? ''
	expect(output).toContain('react marker')
	expect(output).toContain('react dom marker')
	expect(output).not.toMatch(/from\s*["'](?:@justfiles\/app|react)/)
})

test('CSS: import folds into gui.js (no sidecar)', async () => {
	const gui = `import './styles.css'
import { defineGUI } from '@justfiles/app/browser'
export const gui = defineGUI({
	mount(el) {
		el.className = 'box'
		return { update() {}, unmount() {} }
	}
})`
	const { outputs, diagnostics } = await bunCompile(
		project({ 'app.ts': APP, 'gui.ts': gui, 'styles.css': '.box { color: hotpink; }' }, 'gui.ts'),
		runtime
	)
	expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	expect(outputs.find((o) => o.path === 'gui.css')).toBeUndefined()
	const js = outputs.find((o) => o.path === 'gui.js')?.text ?? ''
	expect(js).toContain('hotpink')
	expect(js).toContain('injectStyle')
})

// Real projects (quay's `readProject`) declare entries under `src/` — a directory-
// prefixed entrypoint makes Bun derive `src` as the build root and try to open it on
// the real fs, throwing `failed to open root directory`. Pinning `root` (toolchain.bun.ts)
// keeps the virtual `src/*` entry buildable.
test('directory-prefixed (src/) entries build (no real-fs root probe)', async () => {
	const { outputs, diagnostics } = await bunCompile(
		{
			files: { 'src/app.ts': APP, 'src/gui.ts': GUI },
			entries: { app: 'src/app.ts', gui: 'src/gui.ts' },
			tsconfig: {}
		},
		runtime
	)
	expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	expect(bundlesSdk(outputs.find((o) => o.path === 'app.js')!.text)).toBe(true)
	expect(bundlesSdk(outputs.find((o) => o.path === 'gui.js')!.text)).toBe(true)
})

test('a missing entry is a diagnostic, not a throw', async () => {
	const { outputs, diagnostics } = await bunCompile(
		{ files: { 'app.ts': APP }, entries: { app: 'app.ts', gui: 'nope.ts' }, tsconfig: {} },
		runtime
	)
	expect(bundlesSdk(outputs.find((o) => o.path === 'app.js')!.text)).toBe(true)
	expect(diagnostics.some((d) => d.message.includes('missing entry'))).toBe(true)
})

test('an unsupported npm import is a clear compile error', async () => {
	// Same as the esbuild path: a bare npm package fails with the shared message
	// (Bun throws in onResolve; `throw: false` captures it into result.logs).
	const src = `import { defineApp } from '@justfiles/app'
import _ from 'lodash'
export const app = defineApp({ init: {}, update: () => (void _, {}) })`
	const { diagnostics } = await bunCompile(
		{ files: { 'app.ts': src }, entries: { app: 'app.ts' }, tsconfig: {} },
		runtime
	)
	const errors = diagnostics.filter((d) => d.severity === 'error')
	expect(errors.some((d) => d.message.includes('"lodash" is not supported in app-code'))).toBe(true)
})

test('an undeclared React import is rejected like any other npm package', async () => {
	const src = `import { useState } from 'react'
export const gui = useState`
	const { diagnostics } = await bunCompile(
		{
			files: { 'app.ts': APP, 'gui.ts': src },
			entries: { app: 'app.ts', gui: 'gui.ts' },
			tsconfig: {}
		},
		runtime
	)
	const errors = diagnostics.filter((d) => d.severity === 'error')
	expect(errors.some((d) => d.message.includes('"react" is not supported in app-code'))).toBe(true)
})

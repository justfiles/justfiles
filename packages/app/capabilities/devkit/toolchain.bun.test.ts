// The Bun toolchain, run under `bun test` (needs `Bun.build` + `bun:test`) — the Bun
// half of the toolchain CI matrix. Mirrors `toolchain.test.ts`'s compile assertions and
// adds a shape diff against the esbuild toolchain (both run in one Bun process): same
// `app.js`/`gui.js` outputs, React inlined from the sysroot, the system runtime injected.
// Excluded from the node vitest run (see vitest.config.ts).

import { expect, test } from 'bun:test'
import * as esbuild from 'esbuild'
import { buildRuntime } from './devkit-runtime.ts'
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

// A React component GUI (default export) — exercises jsx automatic + the reactGui
// shim wrap + React bundled out of the runtime map.
const GUI = `import { useState } from 'react'
export default function App() {
	const [n, setN] = useState(0)
	return <button onClick={() => setN(n + 1)}>{n}</button>
}`

const project = (files: Record<string, string>, gui?: string): ProjectInput => ({
	files,
	entries: { app: 'app.ts', ...(gui ? { gui } : {}) },
	tsconfig: {}
})

const runtime = await buildRuntime()
// Nothing is external any more: a devkit output must carry React's own source and
// leave no bare `react` import for a host to resolve.
const inlinesReact = (s: string) =>
	!/from\s*["']react(-dom)?(\/[^"']+)?["']/.test(s) && s.includes('react.transitional.element')
// Every devkit output bundles the SDK: no external/sentinel SDK import survives — the
// source is inlined from the `runtime` map.
const bundlesSdk = (app: string) =>
	!/from\s*["']@justfiles\/app/.test(app) &&
	!/from\s*["']valibot["']/.test(app) &&
	!app.includes('justfiles-sdk:')

test('compile produces named outputs with no errors', async () => {
	const result = await bunCompile(project({ 'app.ts': APP, 'gui.tsx': GUI }, 'gui.tsx'), runtime)
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

test('bundles React into the gui alongside the SDK', async () => {
	const { outputs } = await bunCompile(
		project({ 'app.ts': APP, 'gui.tsx': GUI }, 'gui.tsx'),
		runtime
	)
	const gui = outputs.find((o) => o.path === 'gui.js')!.text
	const app = outputs.find((o) => o.path === 'app.js')!.text
	expect(inlinesReact(gui)).toBe(true)
	// The reducer is headless — React must not reach it.
	expect(/["']react(-dom)?(\/[^"']+)?["']/.test(app)).toBe(false)
	// SDK imports are bundled into both outputs, not externalized.
	expect(bundlesSdk(app)).toBe(true)
	expect(bundlesSdk(gui)).toBe(true)
})

test('emits production automatic JSX (jsx-runtime, not the dev runtime)', async () => {
	// The sysroot React is a production build whose `jsxDEV` is undefined, so a draft
	// must compile to `jsx`/`jsxs` from `react/jsx-runtime` — Bun's default dev runtime
	// (`jsxDEV` from `react/jsx-dev-runtime`) would mount to "jsxDEV is not a function".
	const { outputs } = await bunCompile(
		project({ 'app.ts': APP, 'gui.tsx': GUI }, 'gui.tsx'),
		runtime
	)
	const gui = outputs.find((o) => o.path === 'gui.js')!.text
	expect(gui).not.toContain('jsxDEV')
})

test('shape parity with the esbuild toolchain', async () => {
	const input = project({ 'app.ts': APP, 'gui.tsx': GUI }, 'gui.tsx')
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
	expect(inlinesReact(es.outputs.find((o) => o.path === 'gui.js')!.text)).toBe(true)
	expect(inlinesReact(bun.outputs.find((o) => o.path === 'gui.js')!.text)).toBe(true)
})

test('CSS: import folds into gui.js (no sidecar)', async () => {
	const gui = `import './styles.css'
import { useState } from 'react'
export default function App() {
	const [n] = useState(0)
	return <div className="box">{n}</div>
}`
	const { outputs, diagnostics } = await bunCompile(
		project({ 'app.ts': APP, 'gui.tsx': gui, 'styles.css': '.box { color: hotpink; }' }, 'gui.tsx'),
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
// keeps the virtual `src/*` entry buildable; the `app` entry is the one that broke
// (the `gui` shim is already top-level), so assert both still produce output.
test('directory-prefixed (src/) entries build (no real-fs root probe)', async () => {
	const { outputs, diagnostics } = await bunCompile(
		{
			files: { 'src/app.ts': APP, 'src/gui.tsx': GUI },
			entries: { app: 'src/app.ts', gui: 'src/gui.tsx' },
			tsconfig: {}
		},
		runtime
	)
	expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	expect(bundlesSdk(outputs.find((o) => o.path === 'app.js')!.text)).toBe(true)
	expect(inlinesReact(outputs.find((o) => o.path === 'gui.js')!.text)).toBe(true)
})

test('a missing entry is a diagnostic, not a throw', async () => {
	const { outputs, diagnostics } = await bunCompile(
		{ files: { 'app.ts': APP }, entries: { app: 'app.ts', gui: 'nope.tsx' }, tsconfig: {} },
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

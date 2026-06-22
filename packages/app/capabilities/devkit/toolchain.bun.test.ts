// The Bun toolchain, run under `bun test` (needs `Bun.build` + `bun:test`) — the Bun
// half of the toolchain CI matrix. Mirrors `toolchain.test.ts`'s compile assertions and
// adds a shape diff against the esbuild toolchain (both run in one Bun process): same
// `app.js`/`gui.js` outputs, React kept external, the system runtime injected.
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
// shim wrap + the externalised React singleton.
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
const bareReact = (s: string) =>
	/from\s*["']react["']/.test(s) || /from\s*["']react\/jsx-runtime["']/.test(s)

test('compile produces named outputs with no errors', async () => {
	const result = await bunCompile(project({ 'app.ts': APP, 'gui.tsx': GUI }, 'gui.tsx'), runtime)
	expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	expect(
		result.outputs
			.map((o) => o.path)
			.filter((p) => p.endsWith('.js'))
			.sort()
	).toEqual(['app.js', 'gui.js'])
	expect(result.outputs.find((o) => o.path === 'app.js')?.text).toMatch(
		/from\s*["']justfiles-sdk:@justfiles\/app["']/
	)
})

test('externalizes React (gui, bare) and the SDK (reducer sentinel)', async () => {
	const { outputs } = await bunCompile(
		project({ 'app.ts': APP, 'gui.tsx': GUI }, 'gui.tsx'),
		runtime
	)
	const gui = outputs.find((o) => o.path === 'gui.js')!.text
	const app = outputs.find((o) => o.path === 'app.js')!.text
	expect(bareReact(gui)).toBe(true) // resolved by the shell importmap at load
	expect(gui).not.toContain('function useState') // React not inlined
	// reducer: the SDK + valibot are externalized to the spawn-resolved sentinel, not inlined.
	expect(app).toMatch(/from\s*["']justfiles-sdk:@justfiles\/app["']/)
	expect(app).toMatch(/from\s*["']justfiles-sdk:valibot["']/)
})

test('emits production automatic JSX (jsx-runtime, not the dev runtime)', async () => {
	// The preview's vendored React is a production build with no `jsxDEV`, so a draft
	// must compile to `jsx`/`jsxs` from `react/jsx-runtime` — Bun's default dev runtime
	// (`jsxDEV` from `react/jsx-dev-runtime`) would mount to "jsxDEV is not a function".
	const { outputs } = await bunCompile(
		project({ 'app.ts': APP, 'gui.tsx': GUI }, 'gui.tsx'),
		runtime
	)
	const gui = outputs.find((o) => o.path === 'gui.js')!.text
	expect(gui).toContain('react/jsx-runtime')
	expect(gui).not.toContain('jsx-dev-runtime')
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
	expect(bareReact(es.outputs.find((o) => o.path === 'gui.js')!.text)).toBe(true)
	expect(bareReact(bun.outputs.find((o) => o.path === 'gui.js')!.text)).toBe(true)
})

test('CSS: import bundles to a .css sidecar (the esbuild path lacks this)', async () => {
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
	const css = outputs.find((o) => o.path === 'gui.css')
	expect(css?.text).toContain('#ff69b4') // bundled AND optimized (hotpink → #ff69b4)
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
	expect(outputs.find((o) => o.path === 'app.js')?.text).toMatch(
		/from\s*["']justfiles-sdk:@justfiles\/app["']/
	)
	expect(bareReact(outputs.find((o) => o.path === 'gui.js')!.text)).toBe(true)
})

test('a missing entry is a diagnostic, not a throw', async () => {
	const { outputs, diagnostics } = await bunCompile(
		{ files: { 'app.ts': APP }, entries: { app: 'app.ts', gui: 'nope.tsx' }, tsconfig: {} },
		runtime
	)
	expect(outputs.find((o) => o.path === 'app.js')?.text).toMatch(
		/from\s*["']justfiles-sdk:@justfiles\/app["']/
	)
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

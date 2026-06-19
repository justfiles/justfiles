// The Bun engine, run under `bun test` (needs `Bun.build` + `bun:test`) — the Bun
// half of the engine CI matrix. Mirrors `engine.test.ts`'s compile assertions and
// adds a shape diff against the esbuild engine (both run in one Bun process): same
// `app.js`/`gui.js` outputs, React kept external, the system runtime injected.
// Excluded from the node vitest run (see vitest.config.ts).

import { expect, test } from 'bun:test'
import * as esbuild from 'esbuild'
import { buildRuntime } from './devkit-runtime.ts'
import { bunCompile } from './engine.bun.ts'
import { esbuildCompile } from './engine.esbuild.ts'
import type { ProjectInput } from './engine.ts'

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
	expect(result.outputs.find((o) => o.path === 'app.js')?.text).toContain('dispatch')
})

test('keeps React external and bundles valibot from the injected runtime', async () => {
	const { outputs } = await bunCompile(
		project({ 'app.ts': APP, 'gui.tsx': GUI }, 'gui.tsx'),
		runtime
	)
	const gui = outputs.find((o) => o.path === 'gui.js')!.text
	const app = outputs.find((o) => o.path === 'app.js')!.text
	expect(bareReact(gui)).toBe(true) // resolved by the shell importmap at load
	expect(gui).not.toContain('function useState') // React not inlined
	expect(app).not.toMatch(/from\s*["']valibot["']/) // valibot pulled from runtime, not bare
})

test('shape parity with the esbuild engine', async () => {
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

test('a missing entry is a diagnostic, not a throw', async () => {
	const { outputs, diagnostics } = await bunCompile(
		{ files: { 'app.ts': APP }, entries: { app: 'app.ts', gui: 'nope.tsx' }, tsconfig: {} },
		runtime
	)
	expect(outputs.find((o) => o.path === 'app.js')?.text).toContain('dispatch')
	expect(diagnostics.some((d) => d.message.includes('missing entry'))).toBe(true)
})

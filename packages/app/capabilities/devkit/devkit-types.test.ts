// `bakeTypes` is what lets a no-node_modules host (quay's shipped bun exe, the browser
// container) still type-check a draft: it collects the SDK `.d.ts` into a
// `TypesBundle` the in-memory checker overlays. These tests lock in that the bundle is
// COMPLETE enough to type the starter project cleanly — and still catches real errors —
// so a new SDK type dependency (a missing csstype-style transitive) regresses loudly.

import * as ts from 'typescript'
import { expect, test } from 'vitest'
import { bakeTypes } from './devkit-runtime.ts'
import type { ProjectInput } from './toolchain.ts'
import { typescriptToolchain } from './toolchain.typescript.ts'

// The exact app-code starter (projects.ts): defineApp + valibot, and a plain-DOM GUI
// typed off the app through `defineGUI` — exercises the SDK and valibot type chain.
const APP = `import { defineApp } from '@justfiles/app'
import * as v from 'valibot'
export type CounterState = { count: number }
export const app = defineApp({
	init: { count: 0 } as CounterState,
	update: (t) => ({
		increment: t.on(
			v.object({ amount: v.number() }),
			(state, { amount }) => ({ ...state, count: state.count + amount })
		)
	})
})`
const GUI = `import { defineGUI } from '@justfiles/app/browser'
import type { app } from './app'
export const gui = defineGUI<typeof app>({
	mount(root, state, { client }) {
		const button = document.createElement('button')
		button.onclick = () => void client.increment({ amount: 1 })
		root.append(button)
		const render = (next: { count: number } | null) => {
			button.textContent = String(next?.count ?? 0)
		}
		render(state)
		return { update: render, unmount: () => button.remove() }
	}
})`

const tsconfig: ProjectInput['tsconfig'] = {
	compilerOptions: {
		target: 'es2022',
		lib: ['es2022', 'dom', 'dom.iterable'],
		module: 'esnext',
		moduleResolution: 'bundler',
		strict: true,
		esModuleInterop: true,
		skipLibCheck: true,
		noEmit: true,
		types: []
	},
	include: ['src/app.ts', 'src/gui.ts']
}

const project = (files: Record<string, string>, entries: Record<string, string>): ProjectInput => ({
	files,
	entries,
	tsconfig
})

const baked = await bakeTypes()
const errors = (input: ProjectInput) =>
	typescriptToolchain({
		compile: async () => ({ outputs: [], diagnostics: [] }),
		ts,
		types: baked.files,
		paths: baked.paths
	}).typecheck!(input).then((r) => r.diagnostics.filter((d) => d.severity === 'error'))

test('bakes the SDK type surface (incl. transitive deps)', () => {
	const keys = Object.keys(baked.files)
	// our SDK headers are tsdown rollups (no /dist/ tree), resolved via paths.
	expect(keys).toContain('node_modules/@justfiles/app/index.d.ts')
	expect(keys).toContain('node_modules/@justfiles/app/browser.d.ts')
	expect(keys.some((k) => k.startsWith('node_modules/valibot/'))).toBe(true)
	// tagged-tag is a transitive dep of type-fest — only present if the BFS walked deps.
	expect(keys.some((k) => k.startsWith('node_modules/tagged-tag/'))).toBe(true)
	// No UI framework reaches a draft's type surface either.
	expect(keys.filter((k) => k.startsWith('node_modules/@types/react'))).toEqual([])
	// our SDK resolves through the paths import-map, not a synthesized package.json.
	expect(baked.paths['@justfiles/app/browser']).toEqual([
		'node_modules/@justfiles/app/browser.d.ts'
	])
})

test('type-checks the starter project cleanly from the baked bundle', async () => {
	const found = await errors(
		project({ 'src/app.ts': APP, 'src/gui.ts': GUI }, { app: 'src/app.ts', gui: 'src/gui.ts' })
	)
	expect(found.map((d) => `${d.code} ${d.message}`)).toEqual([])
})

test('still flags a real type error (the overlay is not a silent pass)', async () => {
	const bad = `import * as v from 'valibot'
const n: number = 'nope'
v.nonexistentFn()`
	const found = await errors(project({ 'src/app.ts': bad }, { app: 'src/app.ts' }))
	expect(found.length).toBeGreaterThan(0)
})

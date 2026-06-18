import * as esbuild from 'esbuild'
import * as ts from 'typescript'
import { beforeAll, describe, expect, test } from 'vitest'
import type { AppManifest } from './app.ts'
import { tsconfigFor } from './devkit.ts'
import { buildRuntime } from './devkit-runtime.ts'
import type { Engine, ProjectInput } from './engine.ts'
import { typescriptEngine } from './engine.typescript.ts'

// Exercises the real Node engine: native esbuild for `compile` and the
// TypeScript compiler API for `typecheck`, both over the in-memory `ProjectInput`.
// `typecheck` resolves the system libs (`@justfiles/app`, `valibot`) from the
// workspace node_modules, the way quayd does.

const APP = `import { defineApp } from '@justfiles/app'
import * as v from 'valibot'
export const app = defineApp({
	init: { count: 0 },
	update: (t) => ({
		increment: t.on(v.object({}), (state) => ({ count: state.count + 1 }))
	})
})`

const GUI = `import { defineGUI } from '@justfiles/app/browser'
export const gui = defineGUI({
	mount(el, state) {
		el.textContent = String((state as { count?: number } | null)?.count ?? 0)
		return { update() {}, unmount() {} }
	}
})`

const manifest = (gui?: string): AppManifest => ({ id: 'demo', name: 'Demo', app: 'app.ts', gui })

const project = (files: Record<string, string>, gui?: string): ProjectInput => ({
	files,
	entries: { app: 'app.ts', ...(gui ? { gui } : {}) },
	tsconfig: tsconfigFor(manifest(gui))
})

describe('typescriptEngine', () => {
	let engine: Engine
	beforeAll(async () => {
		engine = typescriptEngine({ build: esbuild.build, ts, runtime: await buildRuntime() })
	}, 30_000)

	test('compile produces named outputs with no errors', async () => {
		const result = await engine.compile(project({ 'app.ts': APP, 'gui.ts': GUI }, 'gui.ts'))
		expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
		expect(result.outputs.map((o) => o.path).sort()).toEqual(['app.js', 'gui.js'])
		expect(result.outputs.find((o) => o.path === 'app.js')?.text).toContain('dispatch')
	})

	test('typecheck passes a valid project (system imports resolve)', async () => {
		const { diagnostics } = await engine.typecheck(project({ 'app.ts': APP }))
		// No "cannot find module" — the system stdlib resolves — and no real errors.
		expect(diagnostics.filter((d) => d.code === 'TS2307')).toEqual([])
		expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	}, 30_000)

	test('typecheck reports a type error against the draft file', async () => {
		const BAD = `export const app = { init: { count: 0 } }
const wrong: number = 'not a number'
void wrong`
		const { diagnostics } = await engine.typecheck(project({ 'app.ts': BAD }))
		const errors = diagnostics.filter((d) => d.severity === 'error')
		expect(errors.length).toBeGreaterThan(0)
		expect(errors[0]?.file).toBe('app.ts')
		expect(errors.some((d) => d.code === 'TS2322')).toBe(true)
	}, 30_000)
})

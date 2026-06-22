import * as esbuild from 'esbuild'
import * as ts from 'typescript'
import { beforeAll, describe, expect, test } from 'vitest'
import type { AppManifest } from '../../app.ts'
import { tsconfigFor } from './devkit.ts'
import { buildRuntime } from './devkit-runtime.ts'
import { esbuildCompile } from './toolchain.esbuild.ts'
import type { ProjectInput } from './toolchain.ts'
import { typescriptToolchain } from './toolchain.typescript.ts'

// Exercises the real Node toolchain: native esbuild for `compile` and the
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

describe('typescriptToolchain', () => {
	let toolchain: ReturnType<typeof typescriptToolchain>
	beforeAll(async () => {
		const runtime = await buildRuntime()
		toolchain = typescriptToolchain({
			compile: (input) => esbuildCompile(input, esbuild.build, runtime),
			ts
		})
	}, 30_000)

	test('compile produces named outputs with no errors', async () => {
		const result = await toolchain.compile(project({ 'app.ts': APP, 'gui.ts': GUI }, 'gui.ts'))
		expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
		expect(result.outputs.map((o) => o.path).sort()).toEqual(['app.js', 'gui.js'])
		// app.js externalizes the SDK to the `justfiles-sdk:` sentinel (resolved at spawn),
		// not inlined.
		expect(result.outputs.find((o) => o.path === 'app.js')?.text).toMatch(
			/from\s*["']justfiles-sdk:@justfiles\/app["']/
		)
	})

	test('typecheck passes a valid project (system imports resolve)', async () => {
		const { diagnostics } = await toolchain.typecheck(project({ 'app.ts': APP }))
		// No "cannot find module" — the system stdlib resolves — and no real errors.
		expect(diagnostics.filter((d) => d.code === 'TS2307')).toEqual([])
		expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	}, 30_000)

	test('typecheck resolves a relative import between draft files in a subdir', async () => {
		// The draft's own dirs (e.g. `src/`) are virtual — they exist only in the
		// overlay, never on the real fs. Resolution must still find `./app`.
		const app = `import { defineApp } from '@justfiles/app'
export const app = defineApp({ init: { count: 0 }, update: () => ({}) })`
		const gui = `import { defineGUI } from '@justfiles/app/browser'
import { app } from './app'
export const gui = defineGUI({ mount: (el, state) => (void app, { update() {}, unmount() {} }) })`
		const { diagnostics } = await toolchain.typecheck({
			files: { 'src/app.ts': app, 'src/gui.tsx': gui },
			entries: { app: 'src/app.ts', gui: 'src/gui.tsx' },
			tsconfig: tsconfigFor({ id: 'demo', name: 'Demo', app: 'src/app.ts', gui: 'src/gui.tsx' })
		})
		expect(diagnostics.filter((d) => d.code === 'TS2307')).toEqual([])
		expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	}, 30_000)

	test('a declared capability compiles and types its invoke methods', async () => {
		// Authors declare a capability with the real factory, not a `{ id, scopes }`
		// stub — so it ships in the draft runtime AND carries the method contract.
		const src = `import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'
export const app = defineApp({
	init: {},
	capabilities: { volume: volume({ scopes: ['app'] }) },
	update: () => ({}),
	procedures: (p) => ({
		go: p.procedure({ description: '', schema: v.object({}), async run(_, app) {
			await app.invoke('volume', 'mkdir', '/Notes')
			return app.state
		} })
	})
})`
		const input: ProjectInput = {
			files: { 'src/app.ts': src },
			entries: { app: 'src/app.ts' },
			tsconfig: tsconfigFor({ id: 'demo', name: 'Demo', app: 'src/app.ts' })
		}
		// Compiles (the factory resolves from the draft runtime, not node_modules)…
		const compiled = await toolchain.compile(input)
		expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
		// …and typechecks: `invoke`'s method arg resolves to the volume contract, so
		// `'mkdir'` is valid (a stub would collapse it to `never` → TS2345).
		const { diagnostics } = await toolchain.typecheck(input)
		expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	}, 30_000)

	test('an unknown capability method is a type error', async () => {
		const src = `import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'
export const app = defineApp({
	init: {},
	capabilities: { volume: volume({ scopes: ['app'] }) },
	update: () => ({}),
	procedures: (p) => ({
		go: p.procedure({ description: '', schema: v.object({}), async run(_, app) {
			await app.invoke('volume', 'nope', '/Notes')
			return app.state
		} })
	})
})`
		const { diagnostics } = await toolchain.typecheck({
			files: { 'src/app.ts': src },
			entries: { app: 'src/app.ts' },
			tsconfig: tsconfigFor({ id: 'demo', name: 'Demo', app: 'src/app.ts' })
		})
		expect(diagnostics.some((d) => d.code === 'TS2345')).toBe(true)
	}, 30_000)

	test('typecheck reports a type error against the draft file', async () => {
		const BAD = `export const app = { init: { count: 0 } }
const wrong: number = 'not a number'
void wrong`
		const { diagnostics } = await toolchain.typecheck(project({ 'app.ts': BAD }))
		const errors = diagnostics.filter((d) => d.severity === 'error')
		expect(errors.length).toBeGreaterThan(0)
		expect(errors[0]?.file).toBe('app.ts')
		expect(errors.some((d) => d.code === 'TS2322')).toBe(true)
	}, 30_000)

	test('an unsupported npm import is a clear compile error', async () => {
		// app-code links only the host SDK; an external npm package is unsupported and
		// must fail with a clear message, not esbuild's opaque "Could not resolve".
		const src = `import { defineApp } from '@justfiles/app'
import _ from 'lodash'
export const app = defineApp({ init: {}, update: () => (void _, {}) })`
		const { diagnostics } = await toolchain.compile(project({ 'app.ts': src }))
		const errors = diagnostics.filter((d) => d.severity === 'error')
		expect(errors.some((d) => d.message.includes('"lodash" is not supported in app-code'))).toBe(
			true
		)
	})

	test('typecheck reports a useful error for an unsupported npm import', async () => {
		const src = `import { defineApp } from '@justfiles/app'
import x from 'not-a-real-package-xyz'
export const app = defineApp({ init: {}, update: () => (void x, {}) })`
		const { diagnostics } = await toolchain.typecheck(project({ 'app.ts': src }))
		// TS's "cannot find module" — the useful, specific signal alongside the compile error.
		expect(diagnostics.some((d) => d.code === 'TS2307')).toBe(true)
	}, 30_000)
})

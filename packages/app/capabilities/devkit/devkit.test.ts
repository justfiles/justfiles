import * as esbuild from 'esbuild'
import { beforeAll, describe, expect, test } from 'vitest'
import { buildRuntime } from './devkit-runtime.ts'
import { esbuildCompile } from './toolchain.esbuild.ts'
import type { Compile } from './toolchain.ts'

// Exercises the real toolchain with Node esbuild standing in for esbuild-wasm
// (same API); `buildRuntime` produces the same system-library bundles a browser
// host serves as a virtual module.

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

describe('devkit compile', () => {
	let runtime: Record<string, string>
	// Node esbuild bound into the bundler-agnostic compile seam (stands in for the
	// browser's esbuild-wasm; same API).
	const backend: Compile = (input) => esbuildCompile(input, esbuild.build, runtime)
	// The structured-result → { app, gui, diagnostics } adaptation `buildDraft`
	// does internally, reproduced here so these unit tests can drive the bundler
	// with bare file maps (no data volume).
	const compile = async (files: Record<string, string>, entries: Record<string, string>) => {
		const { outputs, diagnostics } = await backend({ files, entries, tsconfig: {} })
		const text = (name: string) =>
			outputs.find((output) => output.path === `${name}.js`)?.text ?? ''
		return {
			app: text('app'),
			gui: text('gui'),
			diagnostics: diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
		}
	}
	beforeAll(async () => {
		runtime = await buildRuntime()
	}, 30_000)

	test('bundles app.ts + gui.ts against the system runtime', async () => {
		const { app, gui, diagnostics } = await compile(
			{ 'app.ts': APP, 'gui.ts': GUI },
			{ app: 'app.ts', gui: 'gui.ts' }
		)
		expect(diagnostics).toEqual([])
		// Both outputs bundle the SDK — no external/sentinel SDK import remains.
		expect(app).not.toMatch(/from\s*["']@justfiles\/app/)
		expect(app).not.toContain('justfiles-sdk:')
		expect(gui).not.toMatch(/from\s*["']@justfiles\/app/)
		expect(gui).not.toContain('justfiles-sdk:')
	})

	// Regression: the system runtime must expose valibot's *named* exports, not
	// a lone default. Bundling valibot's CJS file as an entry collapsed it to
	// `export default`, so a draft's `import * as v` left `v.object` undefined
	// and the bundle compiled `schema: (void 0)({})` — every dispatch then threw
	// `(void 0) is not a function`. The reducer now BUNDLES both the SDK and valibot, so
	// import the self-contained app.js directly and dispatch — proving named exports survive
	// AND the bundled reducer runs with no spawn-time link step.
	test('compiled app dispatches actions (bundled SDK + valibot named exports)', async () => {
		const { app, diagnostics } = await compile(
			{ 'app.ts': APP, 'gui.ts': GUI },
			{ app: 'app.ts', gui: 'gui.ts' }
		)
		expect(diagnostics).toEqual([])
		expect(app).not.toContain('(void 0)(')
		const url = `data:text/javascript;base64,${Buffer.from(app).toString('base64')}`
		const mod = (await import(/* @vite-ignore */ url)) as {
			app: {
				dispatch(
					action: { type: string; params: unknown },
					ctx: { state: unknown }
				): Promise<{ state: unknown; result: unknown }>
			}
		}
		const out = await mod.app.dispatch({ type: 'increment', params: {} }, { state: { count: 0 } })
		expect(out.state).toEqual({ count: 1 })
	})

	// App Code is a built-in authoring tool, not an npm dev environment. React is no
	// longer in the sysroot, so a draft that reaches for it gets the same clear
	// "not supported" diagnostic as any other npm package — not an opaque resolve error.
	test('rejects a React import with the unsupported-package diagnostic', async () => {
		const guiSrc = `import { useState } from 'react'
export const gui = useState`
		const { diagnostics } = await compile(
			{ 'app.ts': APP, 'gui.ts': guiSrc },
			{ app: 'app.ts', gui: 'gui.ts' }
		)
		expect(diagnostics.map((d) => d.message).join('\n')).toMatch(
			/External npm package "react" is not supported/
		)
	})

	test('reports diagnostics on a compile error', async () => {
		const { app, diagnostics } = await compile(
			{ 'app.ts': 'export const app = (', 'gui.ts': GUI },
			{ app: 'app.ts', gui: 'gui.ts' }
		)
		expect(diagnostics.length).toBeGreaterThan(0)
		expect(app).toBe('')
	})
})

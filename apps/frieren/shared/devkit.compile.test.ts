import * as esbuild from 'esbuild'
import { beforeAll, describe, expect, test } from 'vitest'
import { compile } from './devkit.compile.ts'
import { buildRuntime } from './devkit-runtime.bundle.ts'

// Exercises the real toolchain with Node esbuild standing in for esbuild-wasm
// (same API); `buildRuntime` produces the same system-library bundles the
// browser virtual module serves.

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
	beforeAll(async () => {
		runtime = await buildRuntime()
	}, 30_000)

	test('bundles app.ts + gui.ts against the system runtime', async () => {
		const { app, gui, diagnostics } = await compile(
			{ 'app.ts': APP, 'gui.ts': GUI },
			{ app: 'app.ts', gui: 'gui.ts' },
			esbuild.build,
			runtime
		)
		expect(diagnostics).toEqual([])
		expect(app).toContain('dispatch') // the reducer surface is bundled in
		expect(gui.length).toBeGreaterThan(0)
		// @justfiles/app is bundled in, not left as a bare import — app.js is a
		// self-contained module the sandbox worker can run with no importmap.
		expect(app).not.toMatch(/from\s*["']@justfiles\/app["']/)
	})

	// Regression: the system runtime must expose valibot's *named* exports, not
	// a lone default. Bundling valibot's CJS file as an entry collapsed it to
	// `export default`, so a draft's `import * as v` left `v.object` undefined
	// and the bundle compiled `schema: (void 0)({})` — every dispatch then threw
	// `(void 0) is not a function`. Compile + actually dispatch to prove the
	// reducer runs end to end.
	test('compiled app dispatches actions (valibot named exports resolve)', async () => {
		const { app, diagnostics } = await compile(
			{ 'app.ts': APP, 'gui.ts': GUI },
			{ app: 'app.ts', gui: 'gui.ts' },
			esbuild.build,
			runtime
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

	test('keeps React external in gui.tsx so the preview shares the host React', async () => {
		const guiTsx = `import { defineGUI } from '@justfiles/app/browser'
import { createRoot } from 'react-dom/client'
export const gui = defineGUI({
	mount(el) {
		const root = createRoot(el)
		root.render(<div />)
		return { update() {}, unmount() { root.unmount() } }
	}
})`
		const { gui, diagnostics } = await compile(
			{ 'app.ts': APP, 'gui.tsx': guiTsx },
			{ app: 'app.ts', gui: 'gui.tsx' },
			esbuild.build,
			runtime
		)
		expect(diagnostics).toEqual([])
		expect(gui).toMatch(/from\s*"react-dom\/client"/)
		expect(gui).toMatch(/from\s*"react\/jsx-runtime"/)
	})

	test('wraps a default React component gui.tsx as the app GUI', async () => {
		const guiTsx = `import type { GUIProps, GUIMenu } from '@justfiles/app/react'
import type { app } from './app'
export const menu: GUIMenu<typeof app> = (state, actions) => [
	{ title: 'Count', items: [{ title: String(state.count), onSelect: () => void actions.increment({}) }] }
]
export default function Counter({ state, actions }: GUIProps<typeof app>) {
	return <button onClick={() => void actions.increment({})}>{state.count}</button>
}`
		const { gui, diagnostics } = await compile(
			{ 'app.ts': APP, 'gui.tsx': guiTsx },
			{ app: 'app.ts', gui: 'gui.tsx' },
			esbuild.build,
			runtime
		)
		expect(diagnostics).toEqual([])
		expect(gui).toMatch(/from\s*"react"/)
		expect(gui).toMatch(/from\s*"react-dom\/client"/)
		expect(gui).toMatch(/from\s*"react\/jsx-runtime"/)
		expect(gui).toContain('menu')
		expect(gui).not.toContain('initialState')
	})

	test('reports diagnostics on a compile error', async () => {
		const { app, diagnostics } = await compile(
			{ 'app.ts': 'export const app = (', 'gui.ts': GUI },
			{ app: 'app.ts', gui: 'gui.ts' },
			esbuild.build,
			runtime
		)
		expect(diagnostics.length).toBeGreaterThan(0)
		expect(app).toBe('')
	})
})

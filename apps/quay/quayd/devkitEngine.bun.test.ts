// quay's devkit compile backend under Bun (run with `bun test`). Imports `compile`
// through the SAME `#engine` specifier quayd/devkit.ts uses, so a green run proves
// the `bun` import condition resolves to Bun.build and the whole quay compile path
// (incl. buildRuntime via native esbuild) works under bun. Excluded from node vitest.

import { expect, test } from 'bun:test'
import { buildRuntime } from '@justfiles/app/devkit-runtime'
import { compile } from '#engine'

const APP = `import { defineApp } from '@justfiles/app'
import * as v from 'valibot'
export const app = defineApp({
	init: { count: 0 },
	update: (t) => ({
		increment: t.on(v.object({}), (state) => ({ count: state.count + 1 }))
	})
})`

test('#engine compiles a project via Bun.build under bun', async () => {
	const runtime = await buildRuntime() // native esbuild bake — must also run under bun
	const { outputs, diagnostics } = await compile(
		{ files: { 'app.ts': APP }, entries: { app: 'app.ts' }, tsconfig: {} },
		runtime
	)
	expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	const app = outputs.find((o) => o.path === 'app.js')?.text ?? ''
	expect(app).toContain('dispatch') // the reducer surface is bundled
	expect(app).not.toMatch(/from\s*["']valibot["']/) // valibot pulled from the runtime
})

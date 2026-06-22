// Step 6: the shared `loadTypes` loader reassembles app-code's types-only sysroot
// (shipped at `devkit/**`) into the tsc overlay from a bare `read` — quay reads the
// installed app's bytes, frieren the seeded Volume, here an in-memory map. These
// pin the round-trip (emit → load yields the SAME overlay `bakeTypes` produced, so
// the starter typechecks with NO node_modules) and the no-fallback error contract.

import * as ts from 'typescript'
import { expect, test } from 'vitest'
import { bakeTypes } from './devkit-runtime.ts'
import { DEVKIT_SCHEMA, type DevkitIndex, loadTypes } from './devkit-sysroot.ts'
import type { ProjectInput, TypesBundle } from './toolchain.ts'
import { typescriptToolchain } from './toolchain.typescript.ts'

const enc = new TextEncoder()
const NM = 'node_modules/'

// Emit a baked `TypesBundle` into the on-disk shape `devkit-sysroot.ts` ships
// (index.json + `node_modules/`-stripped `devkit/types/<rel>`), as an in-memory
// `read` the loader can replay — exactly the bytes an installed bundle exposes.
function sysroot(bundle: TypesBundle): (path: string) => Promise<Uint8Array> {
	const files: Record<string, Uint8Array> = {}
	const manifest: string[] = []
	for (const [key, content] of Object.entries(bundle)) {
		const rel = key.startsWith(NM) ? key.slice(NM.length) : key
		files[`devkit/types/${rel}`] = enc.encode(content)
		manifest.push(rel)
	}
	const index: DevkitIndex = { schema: DEVKIT_SCHEMA, hash: 'sha256-test', files: manifest.sort() }
	files['devkit/index.json'] = enc.encode(JSON.stringify(index))
	return async (path) => {
		const data = files[path]
		if (!data) throw new Error(`not found: ${path}`)
		return data
	}
}

test('loadTypes reassembles the exact overlay bakeTypes produced', async () => {
	const baked = await bakeTypes()
	const loaded = await loadTypes(sysroot(baked))
	expect(loaded).toEqual(baked)
})

test('the loaded sysroot type-checks the starter with no node_modules in the overlay', async () => {
	const loaded = await loadTypes(sysroot(await bakeTypes()))
	const APP = `import { defineApp } from '@justfiles/app'
import * as v from 'valibot'
export const app = defineApp({
	init: { count: 0 },
	update: (t) => ({
		increment: t.on(v.object({ amount: v.number() }), (s, { amount }) => ({ count: s.count + amount }))
	})
})`
	const GUI = `import type { GUIProps } from '@justfiles/app/react'
import type { app } from './app'
export default function Counter({ state, actions }: GUIProps<typeof app>) {
	return <button onClick={() => void actions.increment({ amount: 1 })}>{state.count}</button>
}`
	const input: ProjectInput = {
		files: { 'src/app.ts': APP, 'src/gui.tsx': GUI },
		entries: { app: 'src/app.ts', gui: 'src/gui.tsx' },
		tsconfig: {
			compilerOptions: {
				target: 'es2022',
				lib: ['es2022', 'dom', 'dom.iterable'],
				module: 'esnext',
				moduleResolution: 'bundler',
				jsx: 'react-jsx',
				jsxImportSource: 'react',
				strict: true,
				esModuleInterop: true,
				skipLibCheck: true,
				noEmit: true,
				types: []
			},
			include: ['src/app.ts', 'src/gui.tsx']
		}
	}
	const tc = typescriptToolchain({
		compile: async () => ({ outputs: [], diagnostics: [] }),
		ts,
		types: loaded
	})
	const { diagnostics } = await tc.typecheck!(input)
	expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
})

test('a missing devkit/index.json is a clear error, not a silent node_modules read', async () => {
	await expect(loadTypes(async () => Promise.reject(new Error('absent')))).rejects.toThrow(
		/devkit\/index\.json/
	)
})

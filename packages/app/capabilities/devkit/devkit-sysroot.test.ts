// The shared devkit sysroot loaders reassemble app-code's shipped `devkit/**` into
// compiler inputs from a bare `read` — quay/frieren/desktop read the installed app's
// bytes, here an in-memory map. These pin the round-trip (emit → load yields the SAME
// types/runtime produced at build time, so compile/typecheck need NO node_modules) and
// the no-fallback error contract.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ts from 'typescript'
import { expect, test } from 'vitest'
import { bakeTypes, buildRuntime, buildSdk, writeSysroot } from './devkit-runtime.ts'
import { DEVKIT_SCHEMA, type DevkitIndex, loadRuntime, loadTypes } from './devkit-sysroot.ts'
import type { ProjectInput, TypesBundle } from './toolchain.ts'
import { typescriptToolchain } from './toolchain.typescript.ts'

const enc = new TextEncoder()
const NM = 'node_modules/'

// Emit baked sysroot maps into the on-disk shape `devkit-sysroot.ts` ships
// (index.json + stripped `devkit/types/<rel>` + `devkit/runtime/<spec>.js`), as an
// in-memory `read` the loaders can replay — exactly the bytes an installed bundle exposes.
function sysroot(
	types: TypesBundle,
	runtime: Record<string, string> = {}
): (path: string) => Promise<Uint8Array> {
	const files: Record<string, Uint8Array> = {}
	const typeManifest: string[] = []
	const runtimeManifest: string[] = []
	for (const [key, content] of Object.entries(types)) {
		const rel = key.startsWith(NM) ? key.slice(NM.length) : key
		files[`devkit/types/${rel}`] = enc.encode(content)
		typeManifest.push(rel)
	}
	for (const [spec, content] of Object.entries(runtime)) {
		const rel = `${spec}.js`
		files[`devkit/runtime/${rel}`] = enc.encode(content)
		runtimeManifest.push(rel)
	}
	const index: DevkitIndex = {
		schema: DEVKIT_SCHEMA,
		hash: 'sha256-test',
		files: typeManifest.sort(),
		runtime: runtimeManifest.sort()
	}
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

test('bakeTypes includes @justfiles/app declarations', async () => {
	const baked = await bakeTypes()
	expect(baked['node_modules/@justfiles/app/dist/index.d.ts']).toBeDefined()
	expect(baked['node_modules/@justfiles/app/dist/capabilities/volume/index.d.ts']).toBeDefined()
})

test('loadRuntime reassembles the exact runtime buildRuntime produced', async () => {
	const baked = await buildRuntime()
	const loaded = await loadRuntime(sysroot({}, baked))
	expect(loaded).toEqual(baked)
})

test('writeSysroot emits loadable types and runtime', async () => {
	const root = await mkdtemp(join(tmpdir(), 'devkit-sysroot-'))
	try {
		const sdk = await buildSdk()
		await writeSysroot(join(root, 'devkit'), sdk)
		const read = (path: string) => readFile(join(root, path))
		expect(await loadTypes(read)).toEqual(sdk.types)
		expect(await loadRuntime(read)).toEqual(sdk.runtime)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
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
	const missing = async () => Promise.reject(new Error('absent'))
	await expect(loadTypes(missing)).rejects.toThrow(/devkit\/index\.json/)
	await expect(loadRuntime(missing)).rejects.toThrow(/devkit\/index\.json/)
})

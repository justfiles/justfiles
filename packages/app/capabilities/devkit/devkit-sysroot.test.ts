// The shared devkit sysroot loaders reassemble app-code's shipped `devkit/**` into
// compiler inputs from a bare `read` — quay/frieren read the installed app's bytes,
// here an in-memory map. These pin the round-trip (emit → load yields the SAME
// types/runtime produced at build time, so compile/typecheck need NO node_modules) and
// the no-fallback error contract.

import { createHash } from 'node:crypto'
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

// Emit baked sysroot maps into the on-disk shape `devkit-sysroot.ts` ships (index.json +
// content-addressed `devkit/store/<id>` blobs, files/runtime mapping logical path → id),
// as an in-memory `read` the loaders can replay — exactly the bytes an installed bundle
// exposes.
function sysroot(
	types: TypesBundle,
	runtime: Record<string, string> = {},
	paths: Record<string, string[]> = {}
): (path: string) => Promise<Uint8Array> {
	const files: Record<string, Uint8Array> = {}
	const typeManifest: Record<string, string> = {}
	const runtimeManifest: Record<string, string> = {}
	const put = (content: string): string => {
		const id = `sha256-${createHash('sha256').update(content).digest('hex')}`
		files[`devkit/store/${id}`] = enc.encode(content)
		return id
	}
	for (const [key, content] of Object.entries(types)) {
		const rel = key.startsWith(NM) ? key.slice(NM.length) : key
		typeManifest[rel] = put(content)
	}
	for (const [spec, content] of Object.entries(runtime))
		runtimeManifest[`${spec}.js`] = put(content)
	const index: DevkitIndex = {
		schema: DEVKIT_SCHEMA,
		hash: 'sha256-test',
		files: typeManifest,
		runtime: runtimeManifest,
		paths
	}
	files['devkit/index.json'] = enc.encode(JSON.stringify(index))
	return async (path) => {
		const data = files[path]
		if (!data) throw new Error(`not found: ${path}`)
		return data
	}
}

// Baked once at module load (a cold tsdown dts rollup is ~seconds) and reused — paid
// at import, outside any per-test timeout.
const baked = await bakeTypes()
const sdk = await buildSdk()

test('loadTypes reassembles the exact overlay bakeTypes produced', async () => {
	const loaded = await loadTypes(sysroot(baked.files, {}, baked.paths))
	expect(loaded.files).toEqual(baked.files)
	expect(loaded.paths).toEqual(baked.paths)
})

test('bakeTypes maps @justfiles/app subpaths through the paths import-map', async () => {
	// SDK headers are tsdown rollups (no /dist/ tree), resolved via the paths import-map.
	expect(baked.files['node_modules/@justfiles/app/index.d.ts']).toBeDefined()
	expect(baked.files['node_modules/@justfiles/app/capabilities/volume.d.ts']).toBeDefined()
	expect(baked.paths['@justfiles/app']).toEqual(['node_modules/@justfiles/app/index.d.ts'])
	expect(baked.paths['@justfiles/app/capabilities/volume']).toEqual([
		'node_modules/@justfiles/app/capabilities/volume.d.ts'
	])
})

test('loadRuntime reassembles the exact runtime buildRuntime produced', async () => {
	const built = await buildRuntime()
	const loaded = await loadRuntime(sysroot({}, built))
	expect(loaded).toEqual(built)
})

test('writeSysroot emits loadable types and runtime', async () => {
	const root = await mkdtemp(join(tmpdir(), 'devkit-sysroot-'))
	try {
		await writeSysroot(join(root, 'devkit'), sdk)
		const read = (path: string) => readFile(join(root, path))
		const loaded = await loadTypes(read)
		expect(loaded.files).toEqual(sdk.types)
		expect(loaded.paths).toEqual(sdk.paths)
		expect(await loadRuntime(read)).toEqual(sdk.runtime)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('the loaded sysroot type-checks the starter with no node_modules in the overlay', async () => {
	const loaded = await loadTypes(sysroot(baked.files, {}, baked.paths))
	const APP = `import { defineApp } from '@justfiles/app'
import * as v from 'valibot'
export const app = defineApp({
	init: { count: 0 },
	update: (t) => ({
		increment: t.on(v.object({ amount: v.number() }), (s, { amount }) => ({ count: s.count + amount }))
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
	const input: ProjectInput = {
		files: { 'src/app.ts': APP, 'src/gui.ts': GUI },
		entries: { app: 'src/app.ts', gui: 'src/gui.ts' },
		tsconfig: {
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
	}
	const tc = typescriptToolchain({
		compile: async () => ({ outputs: [], diagnostics: [] }),
		ts,
		types: loaded.files,
		paths: loaded.paths
	})
	const { diagnostics } = await tc.typecheck!(input)
	expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
})

test('a missing devkit/index.json is a clear error, not a silent node_modules read', async () => {
	const missing = async () => Promise.reject(new Error('absent'))
	await expect(loadTypes(missing)).rejects.toThrow(/devkit\/index\.json/)
	await expect(loadRuntime(missing)).rejects.toThrow(/devkit\/index\.json/)
})

// The runtime map IS the set of specifiers a draft may import, so an app-code bundle
// older than the host's SDK must fail at load, naming what is missing — not on whichever
// draft first imports the absent module, where it would read as "unsupported package".
test('an incomplete runtime sysroot fails at load, naming the missing modules', async () => {
	const built = await buildRuntime()
	const { valibot: _dropped, ...partial } = built
	await expect(loadRuntime(sysroot({}, partial))).rejects.toThrow(
		/sysroot is missing runtime module\(s\): valibot/
	)
})

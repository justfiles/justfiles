import * as esbuild from 'esbuild'
import * as ts from 'typescript'
import { describe, expect, test, vi } from 'vitest'
import {
	type CachedImport,
	type ImportCache,
	resolveImports,
	validateImportMap
} from './imports.ts'
import { esbuildCompile } from './toolchain.esbuild.ts'
import type { ProjectInput } from './toolchain.ts'
import { loadImportTypes, tsTypecheck, tsTypecheckImports } from './toolchain.typescript.ts'

const react = 'https://esm.sh/react@19.1.1'
const reactJsx = 'https://esm.sh/react@19.1.1/jsx-runtime'
const reactDom = 'https://esm.sh/react-dom@19.1.1/client'
const unused = 'https://esm.sh/unused@1.0.0'
const reactMeta = `${react}?meta`
const reactJsxMeta = `${reactJsx}?meta`
const reactDomMeta = `${reactDom}?meta`
const unusedMeta = `${unused}?meta`
const reactCode = 'https://esm.sh/react@19.1.1/es2022/react.mjs'
const reactJsxCode = 'https://esm.sh/react@19.1.1/es2022/jsx-runtime.mjs'
const reactDomCode = 'https://esm.sh/react-dom@19.1.1/es2022/client.mjs'
const dependencyCode = 'https://esm.sh/dependency@1.0.0/es2022/dependency.mjs'
const reactTypes = 'https://esm.sh/@types/react@19.1.0/index.d.ts'
const reactJsxTypes = 'https://esm.sh/@types/react@19.1.0/jsx-runtime.d.ts'
const reactDomTypes = 'https://esm.sh/@types/react-dom@19.1.0/client.d.ts'
const nestedTypes = 'https://esm.sh/@types/react@19.1.0/nested.d.ts'
const rootTypes = 'https://esm.sh/@types/react@19.1.0/root.d.ts'
const rootTypeRef = '/@types/react@19.1.0/root.d.ts'

describe('Devkit import resolver', () => {
	test('uses metadata for entries and leaves JavaScript traversal to esbuild', async () => {
		const fetch = fakeFetch(graph())
		const imports = await resolveImports({ react, unused }, { cache: memoryCache(), fetch })

		expect(imports.diagnostics).toEqual([])
		expect(imports.code.react).toBe(reactCode)
		expect(imports.declarations.react).toBe(reactTypes)
		expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([reactMeta, unusedMeta])

		const result = await esbuildCompile(
			project("import value from 'react'; export { value }"),
			esbuild.build,
			{},
			imports
		)

		expect(result.diagnostics).toEqual([])
		expect(result.outputs[0]?.text).toContain('remote value')
		expect(fetch).toHaveBeenCalledWith(reactCode, expect.anything())
		expect(fetch).toHaveBeenCalledWith(dependencyCode, expect.anything())
		expect(fetch).not.toHaveBeenCalledWith(
			'https://esm.sh/unused@1.0.0/es2022/unused.mjs',
			expect.anything()
		)
	})

	test('uses TypeScript to find declaration references', async () => {
		const imports = await resolveImports(
			{ react },
			{ cache: memoryCache(), fetch: fakeFetch(graph()) }
		)
		const loaded = await loadImportTypes(imports, ts)

		expect(Object.keys(loaded.types)).toEqual([
			'__imports__/esm.sh/@types/react@19.1.0/index.d.ts',
			'__imports__/esm.sh/@types/react@19.1.0/nested.d.ts'
		])
		expect(loaded.paths.react).toEqual(['__imports__/esm.sh/@types/react@19.1.0/index.d.ts'])
		const checked = tsTypecheck(
			project(
				"import type { RemoteValue } from 'react'; const value: RemoteValue = { label: 'ok' }; export { value }"
			),
			ts,
			loaded.types,
			loaded.paths
		)
		expect(checked.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
	})

	test('maps root-relative declaration references', async () => {
		const values = graph()
		values[reactTypes] = {
			text: `/// <reference path="${rootTypeRef}" />\nexport type RemoteValue = RootRelative`
		}
		values[rootTypes] = { text: 'interface RootRelative { label: string }' }
		const imports = await resolveImports(
			{ react },
			{ cache: memoryCache(), fetch: fakeFetch(values) }
		)
		const loaded = await loadImportTypes(imports, ts)

		expect(loaded.paths[rootTypeRef]).toEqual(['__imports__/esm.sh/@types/react@19.1.0/root.d.ts'])
		const checked = tsTypecheck(
			project(
				"import type { RemoteValue } from 'react'; const value: RemoteValue = { label: 1 }; export { value }"
			),
			ts,
			loaded.types,
			loaded.paths
		)
		expect(checked.diagnostics).toEqual([expect.objectContaining({ code: 'TS2322' })])
	})

	test('builds opt-in TSX with declared React subpaths', async () => {
		const imports = await resolveImports(
			{
				'react/jsx-runtime': reactJsx,
				'react-dom/client': reactDom
			},
			{ cache: memoryCache(), fetch: fakeFetch(graph()) }
		)
		const input = project(
			"import { createRoot } from 'react-dom/client'; export const gui = createRoot(<main>ok</main>)"
		)
		input.files = { 'gui.tsx': input.files['app.ts']! }
		input.entries = { gui: 'gui.tsx' }
		input.tsconfig.compilerOptions = { ...input.tsconfig.compilerOptions, jsx: 'react-jsx' }

		const result = await esbuildCompile(input, esbuild.build, {}, imports)

		expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
		const output = result.outputs[0]?.text ?? ''
		expect(output).toContain('jsx runtime marker')
		expect(output).toContain('react dom client marker')
		expect(output).not.toMatch(/(?:from\s*|import\()["']https:\/\/esm\.sh/)
	})

	test('does not enable JSX for every TSX file', async () => {
		const input = project('export const gui = <main>no implicit JSX</main>')
		input.files = { 'gui.tsx': input.files['app.ts']! }
		input.entries = { gui: 'gui.tsx' }

		const result = await esbuildCompile(input, esbuild.build, {})

		expect(result.diagnostics.filter((item) => item.severity === 'error')).not.toEqual([])
	})

	test('reports a missing subpath export in the project source', async () => {
		const imports = await resolveImports(
			{
				'react/jsx-runtime': reactJsx,
				'react-dom/client': reactDom
			},
			{ cache: memoryCache(), fetch: fakeFetch(graph()) }
		)
		const input = project(
			"import { Missing } from 'react-dom/client'; export const value = Missing"
		)

		const checked = await tsTypecheckImports(input, ts, {}, {}, imports)

		expect(checked.diagnostics).toEqual([
			expect.objectContaining({ file: 'app.ts', code: 'TS2305' })
		])
	})

	test('does not report package declaration errors as project errors', async () => {
		const imports = await resolveImports(
			{ 'react-dom/client': reactDom },
			{ cache: memoryCache(), fetch: fakeFetch(graph()) }
		)
		const loaded = await loadImportTypes(imports, ts)

		const checked = tsTypecheck(
			project("import { createRoot } from 'react-dom/client'; export const root = createRoot('x')"),
			ts,
			loaded.types,
			loaded.paths
		)

		expect(checked.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
	})

	test('uses a valid lock and cache without network access', async () => {
		const cache = memoryCache()
		const first = await resolveImports({ react }, { cache, fetch: fakeFetch(graph()) })
		await esbuildCompile(project("import 'react'"), esbuild.build, {}, first)
		await loadImportTypes(first, ts)
		const lock = first.lock()
		const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error('offline')))

		const second = await resolveImports({ react }, { cache, fetch, lock })
		await esbuildCompile(project("import 'react'"), esbuild.build, {}, second)
		await loadImportTypes(second, ts)

		expect(second.diagnostics).toEqual([])
		expect(second.lock()).toEqual(lock)
		expect(fetch).not.toHaveBeenCalled()
	})

	test('extends a valid build lock with the declaration graph', async () => {
		const cache = memoryCache()
		const values = graph()
		const finalTypes = 'https://esm.sh/@types/react@19.1.2/index.d.ts'
		values[reactTypes] = {
			url: finalTypes,
			text: values[reactTypes]!.text
		}
		values['https://esm.sh/@types/react@19.1.2/nested.d.ts'] = values[nestedTypes]!
		const first = await resolveImports({ react }, { cache, fetch: fakeFetch(values) })
		await esbuildCompile(project("import 'react'"), esbuild.build, {}, first)
		const buildLock = first.lock()

		const second = await resolveImports(
			{ react },
			{ cache, fetch: fakeFetch(values), lock: buildLock, frozen: false }
		)
		await loadImportTypes(second, ts)

		expect(second.lock().redirects[reactTypes]).toBe(finalTypes)
		expect(second.lock().remote).toHaveProperty(finalTypes)

		const fullLock = second.lock()
		const third = await resolveImports(
			{ react },
			{ cache, fetch: fakeFetch(values), lock: fullLock }
		)
		await esbuildCompile(project("import 'react'"), esbuild.build, {}, third)
		expect(third.lock()).toEqual(fullLock)
	})

	test('reports changed cached content against the lock', async () => {
		const cache = memoryCache()
		const first = await resolveImports({ react }, { cache, fetch: fakeFetch(graph()) })
		await esbuildCompile(project("import 'react'"), esbuild.build, {}, first)
		const lock = first.lock()
		cache.values.get(reactCode)!.text = 'export const changed = true'
		const second = await resolveImports({ react }, { cache, fetch: fakeFetch(graph()), lock })

		const result = await esbuildCompile(project("import 'react'"), esbuild.build, {}, second)

		expect(result.diagnostics[0]).toMatchObject({ source: 'esbuild', severity: 'error' })
		expect(result.diagnostics[0]?.message).toContain('devkit-lock.json')
	})

	test('records a redirect to the final URL', async () => {
		const final = 'https://esm.sh/@types/react@19.1.2/index.d.ts'
		const values = graph()
		values[reactTypes] = { url: final, text: 'export interface RemoteValue {}' }
		const imports = await resolveImports(
			{ react },
			{ cache: memoryCache(), fetch: fakeFetch(values) }
		)

		await loadImportTypes(imports, ts)

		expect(imports.lock().redirects[reactTypes]).toBe(final)
		expect(imports.lock().remote).toHaveProperty(final)
	})

	test('rejects Node modules while esbuild resolves the graph', async () => {
		const values = graph()
		values[reactCode] = { text: 'export * from "/node/fs.mjs"' }
		const imports = await resolveImports(
			{ react },
			{ cache: memoryCache(), fetch: fakeFetch(values) }
		)

		const result = await esbuildCompile(project("import 'react'"), esbuild.build, {}, imports)

		expect(result.diagnostics[0]?.message).toContain('Node import is not supported')
	})

	test('rejects computed dynamic imports in remote modules', async () => {
		const values = graph()
		values[reactCode] = {
			text: 'const url = "/dependency@1.0.0/es2022/dependency.mjs"; export const load = () => import(url)'
		}
		const imports = await resolveImports(
			{ react },
			{ cache: memoryCache(), fetch: fakeFetch(values) }
		)

		const result = await esbuildCompile(
			project("import { load } from 'react'; load()"),
			esbuild.build,
			{},
			imports
		)

		expect(result.diagnostics[0]?.message).toContain('Dynamic import must use a string literal')
	})

	test('limits one file by bytes', async () => {
		const imports = await resolveImports(
			{ react },
			{ cache: memoryCache(), fetch: fakeFetch(graph()), limits: { fileBytes: 10 } }
		)

		expect(imports.diagnostics[0]).toMatchObject({ code: 'IMPORT_FILE_SIZE' })
	})

	test('limits graph depth in the build tool', async () => {
		const imports = await resolveImports(
			{ react },
			{ cache: memoryCache(), fetch: fakeFetch(graph()), limits: { depth: 0 } }
		)

		const result = await esbuildCompile(project("import 'react'"), esbuild.build, {}, imports)

		expect(result.diagnostics[0]?.message).toContain('too deep')
	})

	test('limits graph file count in the shared URL store', async () => {
		const imports = await resolveImports(
			{ react },
			{ cache: memoryCache(), fetch: fakeFetch(graph()), limits: { files: 2 } }
		)

		const result = await esbuildCompile(project("import 'react'"), esbuild.build, {}, imports)

		expect(result.diagnostics[0]?.message).toContain('too many files')
	})

	test('limits total graph bytes', async () => {
		const imports = await resolveImports(
			{ react },
			{ cache: memoryCache(), fetch: fakeFetch(graph()), limits: { totalBytes: 20 } }
		)

		expect(imports.diagnostics[0]).toMatchObject({ code: 'IMPORT_TOTAL_SIZE' })
	})

	test('limits request time', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
				})
		)
		const imports = await resolveImports(
			{ react },
			{ cache: memoryCache(), fetch, limits: { timeoutMs: 1 } }
		)

		expect(imports.diagnostics[0]).toMatchObject({ code: 'IMPORT_FETCH' })
		expect(imports.diagnostics[0]?.message).toContain('timeout')
	})

	test('reports the fetch redirect limit', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(() =>
			Promise.reject(new TypeError('redirect count exceeded'))
		)
		const imports = await resolveImports({ react }, { cache: memoryCache(), fetch })

		expect(imports.diagnostics[0]).toMatchObject({ code: 'IMPORT_FETCH' })
		expect(imports.diagnostics[0]?.message).toContain('redirect count exceeded')
	})
})

describe('Devkit import map', () => {
	test('requires exact esm.sh package versions', () => {
		expect(validateImportMap({ react })).toEqual({ react })
		expect(() => validateImportMap({ react: 'https://esm.sh/react' })).toThrow(/pinned/)
		expect(() => validateImportMap({ react: 'http://esm.sh/react@19.1.1' })).toThrow(/pinned/)
	})

	test('does not let a project replace the platform runtime', () => {
		expect(() => validateImportMap({ '@justfiles/app': react })).toThrow(/platform/)
		expect(() => validateImportMap({ '@justfiles/app/private': react })).toThrow(/platform/)
	})
})

interface Fixture {
	text: string
	url?: string
}

function graph(): Record<string, Fixture> {
	return {
		[reactMeta]: {
			text: JSON.stringify({
				module: '/react@19.1.1/es2022/react.mjs',
				dts: '/@types/react@19.1.0/index.d.ts'
			})
		},
		[reactJsxMeta]: {
			text: JSON.stringify({
				module: '/react@19.1.1/es2022/jsx-runtime.mjs',
				dts: '/@types/react@19.1.0/jsx-runtime.d.ts'
			})
		},
		[reactDomMeta]: {
			text: JSON.stringify({
				module: '/react-dom@19.1.1/es2022/client.mjs',
				dts: '/@types/react-dom@19.1.0/client.d.ts'
			})
		},
		[unusedMeta]: {
			text: JSON.stringify({ module: '/unused@1.0.0/es2022/unused.mjs' })
		},
		[reactCode]: {
			text: 'import { dependency } from "/dependency@1.0.0/es2022/dependency.mjs"; export default dependency'
		},
		[reactJsxCode]: {
			text: `export const Fragment = Symbol();
export const jsx = (type, props) => ({ type, props, marker: 'jsx runtime marker' });
export const jsxs = jsx`
		},
		[reactDomCode]: {
			text: "export const createRoot = (value) => ({ value, marker: 'react dom client marker' })"
		},
		[dependencyCode]: { text: 'export const dependency = "remote value"' },
		[reactTypes]: {
			text: "export interface RemoteValue { label: string }; export type NestedValue = import('./nested.d.ts').NestedValue"
		},
		[reactJsxTypes]: {
			text: `export namespace JSX { export interface IntrinsicElements { [name: string]: unknown } }
export declare const Fragment: unique symbol
export declare function jsx(type: unknown, props: unknown): unknown
export { jsx as jsxs }`
		},
		[reactDomTypes]: {
			text: `export declare function createRoot(value: unknown): { value: unknown }
export type BrokenPackageType = MissingPackageType`
		},
		[nestedTypes]: { text: 'export interface NestedValue { value: number }' }
	}
}

function project(source: string): ProjectInput {
	return {
		files: { 'app.ts': source },
		entries: { app: 'app.ts' },
		tsconfig: {
			compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'Bundler' }
		}
	}
}

function fakeFetch(values: Record<string, Fixture>) {
	return vi.fn<typeof globalThis.fetch>(async (url, _init) => {
		const key = String(url)
		const value = values[key]
		if (!value) return response(key, 'not found', 404)
		return response(value.url ?? key, value.text)
	})
}

function response(url: string, body: string, status = 200): Response {
	const value = new Response(body, { status })
	Object.defineProperty(value, 'url', { value: url })
	return value
}

function memoryCache(): ImportCache & { values: Map<string, CachedImport> } {
	const values = new Map<string, CachedImport>()
	return {
		values,
		async get(url) {
			return values.get(url)
		},
		async put(url, value) {
			values.set(url, { ...value })
		}
	}
}

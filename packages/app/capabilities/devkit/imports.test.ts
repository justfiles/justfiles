import { describe, expect, test, vi } from 'vitest'
import {
	type CachedImport,
	type ImportCache,
	resolveImports,
	validateImportMap
} from './imports.ts'

const react = 'https://esm.sh/react@19.1.1'
const reactDom = 'https://esm.sh/react-dom@19.1.1/client?bundle&deps=react@19.1.1'
const imports = { react, 'react-dom/client': reactDom }

describe('Devkit import resolver', () => {
	test('resolves and locks JavaScript and declaration graphs', async () => {
		const cache = memoryCache()
		const fetch = fakeFetch(graph())
		const result = await resolveImports(imports, { cache, fetch })

		expect(result.diagnostics).toEqual([])
		expect(result.paths).toEqual({
			react: ['https://esm.sh/@types/react@19.1.0/index.d.ts'],
			'react-dom/client': ['https://esm.sh/@types/react-dom@19.1.0/client.d.ts']
		})
		expect(result.runtime.react).toBe(result.runtime[react])
		expect(result.runtime['react-dom/client']).toBe(result.runtime[reactDom])
		expect(Object.keys(result.runtime)).toHaveLength(6)
		expect(Object.keys(result.types)).toHaveLength(3)
		expect(Object.keys(result.lock!.files)).toHaveLength(7)
		expect(Object.values(result.lock!.files).every((file) => file.hash.startsWith('sha256-'))).toBe(
			true
		)
		expect(fetch).toHaveBeenCalled()
		for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ credentials: 'omit' })
	})

	test('uses a valid lock and cache without network access', async () => {
		const cache = memoryCache()
		const first = await resolveImports(imports, { cache, fetch: fakeFetch(graph()) })
		const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error('offline')))

		const second = await resolveImports(imports, { cache, fetch, lock: first.lock })

		expect(second.diagnostics).toEqual([])
		expect(second.lock).toEqual(first.lock)
		expect(fetch).not.toHaveBeenCalled()
	})

	test('reports changed cached content against the lock', async () => {
		const cache = memoryCache()
		const first = await resolveImports(imports, { cache, fetch: fakeFetch(graph()) })
		cache.values.get(react)!.text = 'export const changed = true'

		const second = await resolveImports(imports, {
			cache,
			fetch: fakeFetch(graph()),
			lock: first.lock
		})

		expect(second.diagnostics[0]).toMatchObject({
			source: 'imports',
			code: 'IMPORT_LOCK_MISMATCH'
		})
	})

	test('rejects Node modules before it fetches them', async () => {
		const fetch = fakeFetch({
			[react]: { text: 'export * from "/node/fs.mjs"' }
		})

		const result = await resolveImports({ react }, { cache: memoryCache(), fetch })

		expect(result.diagnostics[0]).toMatchObject({ code: 'IMPORT_NODE' })
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	test('records the final URL after a redirect', async () => {
		const finalUrl = 'https://esm.sh/react@19.1.1/es2022/react.mjs'
		const result = await resolveImports(
			{ react },
			{
				cache: memoryCache(),
				fetch: fakeFetch({ [react]: { url: finalUrl, text: 'export {}' } })
			}
		)

		expect(result.runtime.react).toBe(result.runtime[finalUrl])
		expect(result.lock?.imports.react?.url).toBe(finalUrl)
		expect(result.lock?.files).toHaveProperty(finalUrl)
	})

	test('reports two versions of one package', async () => {
		const values = graph()
		values['https://esm.sh/@types/react-dom@19.1.0/client.d.ts'] = {
			text: 'import "https://esm.sh/@types/react@19.2.0/index.d.ts"'
		}
		values['https://esm.sh/@types/react@19.2.0/index.d.ts'] = { text: 'export {}' }

		const result = await resolveImports(imports, {
			cache: memoryCache(),
			fetch: fakeFetch(values)
		})

		expect(result.diagnostics[0]).toMatchObject({ code: 'IMPORT_VERSION_CONFLICT' })
	})

	test('limits one file by bytes', async () => {
		const result = await resolveImports(
			{ react },
			{
				cache: memoryCache(),
				fetch: fakeFetch({ [react]: { text: 'export const value = "too long"' } }),
				limits: { fileBytes: 10 }
			}
		)

		expect(result.diagnostics[0]).toMatchObject({ code: 'IMPORT_FILE_SIZE' })
	})

	test('limits graph depth', async () => {
		const result = await resolveImports(
			{ react },
			{
				cache: memoryCache(),
				fetch: fakeFetch({
					[react]: { text: 'export * from "/a@1.0.0/a.mjs"' },
					'https://esm.sh/a@1.0.0/a.mjs': { text: 'export * from "/b@1.0.0/b.mjs"' },
					'https://esm.sh/b@1.0.0/b.mjs': { text: 'export {}' }
				}),
				limits: { depth: 1 }
			}
		)

		expect(result.diagnostics[0]).toMatchObject({ code: 'IMPORT_DEPTH' })
	})

	test('limits graph file count', async () => {
		const result = await resolveImports(
			{ react },
			{
				cache: memoryCache(),
				fetch: fakeFetch({
					[react]: { text: 'export * from "/a@1.0.0/a.mjs"' },
					'https://esm.sh/a@1.0.0/a.mjs': { text: 'export {}' }
				}),
				limits: { files: 1 }
			}
		)

		expect(result.diagnostics[0]).toMatchObject({ code: 'IMPORT_FILE_COUNT' })
	})

	test('limits total graph bytes', async () => {
		const result = await resolveImports(
			{ react },
			{
				cache: memoryCache(),
				fetch: fakeFetch({
					[react]: { text: 'export * from "/a@1.0.0/a.mjs"' },
					'https://esm.sh/a@1.0.0/a.mjs': { text: 'export const a = 1' }
				}),
				limits: { fileBytes: 100, totalBytes: 40 }
			}
		)

		expect(result.diagnostics[0]).toMatchObject({ code: 'IMPORT_TOTAL_SIZE' })
	})

	test('limits request time', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
				})
		)
		const result = await resolveImports(
			{ react },
			{
				cache: memoryCache(),
				fetch,
				limits: { timeoutMs: 1 }
			}
		)

		expect(result.diagnostics[0]).toMatchObject({ code: 'IMPORT_FETCH' })
		expect(result.diagnostics[0]?.message).toContain('timeout')
	})

	test('reports the Fetch redirect limit', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(() =>
			Promise.reject(new TypeError('redirect count exceeded'))
		)
		const result = await resolveImports({ react }, { cache: memoryCache(), fetch })

		expect(result.diagnostics[0]).toMatchObject({ code: 'IMPORT_FETCH' })
		expect(result.diagnostics[0]?.message).toContain('redirect count exceeded')
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

function graph(): Record<string, { text: string; types?: string; url?: string }> {
	return {
		[react]: {
			text: 'export * from "/react@19.1.1/es2022/react.mjs"',
			types: '/@types/react@19.1.0/index.d.ts'
		},
		[reactDom]: {
			text: 'export * from "/react-dom@19.1.1/es2022/client.mjs"',
			types: '/@types/react-dom@19.1.0/client.d.ts'
		},
		'https://esm.sh/react@19.1.1/es2022/react.mjs': {
			text: 'export const createElement = () => null'
		},
		'https://esm.sh/react-dom@19.1.1/es2022/client.mjs': {
			text: 'import "/react@19.1.1/es2022/react.mjs"; export const createRoot = () => null'
		},
		'https://esm.sh/@types/react@19.1.0/index.d.ts': {
			text: 'import { Properties } from "https://esm.sh/csstype@3.1.3/index.d.ts"; export {}'
		},
		'https://esm.sh/@types/react-dom@19.1.0/client.d.ts': {
			text: 'import * as React from "react"; export {}'
		},
		'https://esm.sh/csstype@3.1.3/index.d.ts': { text: 'export interface Properties {}' }
	}
}

function fakeFetch(values: ReturnType<typeof graph>) {
	return vi.fn<typeof globalThis.fetch>(async (url, _init) => {
		const key = String(url)
		const value = values[key]
		if (!value) return response(key, 'not found', {}, 404)
		return response(value.url ?? key, value.text, {
			...(value.types ? { 'x-typescript-types': value.types } : {})
		})
	})
}

function response(
	url: string,
	body: string,
	headers: Record<string, string>,
	status = 200
): Response {
	const value = new Response(body, { headers, status })
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

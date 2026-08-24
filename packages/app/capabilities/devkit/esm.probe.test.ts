import { build, type Plugin } from 'esbuild'
import * as ts from 'typescript'
import { expect, test, vi } from 'vitest'
import { type CachedImport, type ImportCache, resolveImports } from './imports.ts'
import { esbuildCompile } from './toolchain.esbuild.ts'
import type { ProjectInput } from './toolchain.ts'
import { tsTypecheckImports } from './toolchain.typescript.ts'

const react = 'https://esm.sh/react@19.1.1'
const reactJsx = 'https://esm.sh/react@19.1.1/jsx-runtime'
const reactDom = 'https://esm.sh/react-dom@19.1.1/client?bundle&deps=react@19.1.1'
const nodePackage = 'https://esm.sh/better-sqlite3@12.2.0?bundle'
const probe = process.env.DEVKIT_CDN_PROBE === '1' ? test : test.skip

probe(
	'esm.sh supplies a browser React graph and types',
	async () => {
		const reactEntry = await get(react)
		const reactDomEntry = await get(reactDom)

		expect(reactEntry.types).toMatch(/^https:\/\/esm\.sh\/@types\/react@/)
		expect(reactDomEntry.types).toMatch(/^https:\/\/esm\.sh\/@types\/react-dom@/)
		expect(reactEntry.text).toContain('/react@19.1.1/es2022/react.mjs')
		expect(reactDomEntry.text).toContain('/react@19.1.1/es2022/react.mjs')

		const reactTypes = await get(reactEntry.types!)
		const reactDomTypes = await get(reactDomEntry.types!)
		expect(reactTypes.url).toMatch(/\/@types\/react@\d+\.\d+\.\d+\/index\.d\.ts$/)
		expect(reactTypes.text).toContain('https://esm.sh/csstype@')
		expect(reactDomTypes.url).toMatch(/\/@types\/react-dom@\d+\.\d+\.\d+\/client\.d\.ts$/)
		expect(reactDomTypes.text).toContain('https://esm.sh/@types/react@')
		await Promise.all(
			[reactTypes, reactDomTypes].flatMap((entry) =>
				typeRefs(entry.text)
					.filter(
						(path) => path.startsWith('.') || path.startsWith('/') || path.startsWith('https://')
					)
					.map((path) => get(new URL(path, entry.url).href))
			)
		)
	},
	30_000
)

probe(
	'cached React modules build without network access',
	async () => {
		const imports = new Map([
			['react', react],
			['react-dom/client', reactDom]
		])
		const modules = new Map<string, string>()
		await Promise.all([...imports.values()].map((url) => cacheGraph(url, modules)))
		expect(modules.size).toBeGreaterThanOrEqual(4)

		const offline = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
		try {
			const result = await build({
				stdin: {
					contents: `import React from 'react'
import { createRoot } from 'react-dom/client'
createRoot(document.body).render(React.createElement('main', null, 'hello'))`,
					loader: 'ts',
					sourcefile: 'src/gui.ts'
				},
				bundle: true,
				format: 'esm',
				platform: 'browser',
				write: false,
				plugins: [cachedModules(imports, modules)]
			})
			expect(result.outputFiles[0]?.text.length).toBeGreaterThan(100_000)
			expect(offline).not.toHaveBeenCalled()
		} finally {
			offline.mockRestore()
		}
	},
	30_000
)

probe(
	'a Node package exposes imports that Devkit can reject',
	async () => {
		const entry = await get(nodePackage)
		expect(entry.types).toBeNull()
		expect(moduleRefs(entry.text)).toContain('/node/fs.mjs')
	},
	30_000
)

probe(
	'the Devkit graph builds and checks React from its offline cache',
	async () => {
		const cache = memoryCache()
		const map = {
			react,
			'react/jsx-runtime': reactJsx,
			'react-dom/client': reactDom
		}
		const input: ProjectInput = {
			files: {
				'gui.tsx': `import { useState } from 'react'
import { createRoot } from 'react-dom/client'
const View = () => {
	const [count] = useState(1)
	return <main>{count}</main>
}
createRoot(document.body).render(<View />)`
			},
			entries: { gui: 'gui.tsx' },
			tsconfig: {
				compilerOptions: {
					lib: ['es2022', 'dom'],
					module: 'esnext',
					moduleResolution: 'bundler',
					strict: true,
					jsx: 'react-jsx'
				}
			}
		}
		const online = await resolveImports(map, { cache })
		const built = await esbuildCompile(input, build, {}, online)
		const checked = await tsTypecheckImports(input, ts, {}, {}, online)
		expect(built.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
		expect(checked.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
		const lock = online.lock()
		expect(
			Object.keys(lock.remote).filter((url) => url.includes('/react@19.1.1/es2022/react.mjs'))
		).toHaveLength(1)

		const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error('offline')))
		const offline = await resolveImports(map, { cache, fetch, lock })
		const rebuilt = await esbuildCompile(input, build, {}, offline)
		const rechecked = await tsTypecheckImports(input, ts, {}, {}, offline)
		expect(rebuilt.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
		expect(rechecked.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
		expect(offline.lock()).toEqual(lock)
		expect(fetch).not.toHaveBeenCalled()
	},
	30_000
)

async function get(url: string): Promise<{ url: string; text: string; types: string | null }> {
	const response = await fetch(url, { credentials: 'omit' })
	expect(response.ok, `${url} returned ${response.status}`).toBe(true)
	expect(response.headers.get('access-control-allow-origin')).toBe('*')
	expect(response.headers.get('cache-control')).toContain('immutable')
	return {
		url: response.url,
		text: await response.text(),
		types: response.headers.get('x-typescript-types')
	}
}

async function cacheGraph(url: string, modules: Map<string, string>): Promise<void> {
	if (modules.has(url)) return
	if (modules.size >= 40) throw new Error('probe module limit reached')
	const module = await get(url)
	modules.set(url, module.text)
	modules.set(module.url, module.text)
	await Promise.all(
		moduleRefs(module.text)
			.filter((path) => path.startsWith('.') || path.startsWith('/') || path.startsWith('https://'))
			.map((path) => cacheGraph(new URL(path, module.url).href, modules))
	)
}

function moduleRefs(source: string): string[] {
	const pattern = /\b(?:import|export)\s*(?:[^"']*?\sfrom\s*)?["']([^"']+)["']/g
	return [...source.matchAll(pattern)].map((match) => match[1]!)
}

function typeRefs(source: string): string[] {
	return [
		...[...source.matchAll(/^(?:import|export)\b[^"'\n]*["']([^"']+)["']/gm)].map(
			(match) => match[1]!
		),
		...[...source.matchAll(/reference path=["']([^"']+)["']/g)].map((match) => match[1]!)
	]
}

function cachedModules(imports: Map<string, string>, modules: Map<string, string>): Plugin {
	return {
		name: 'cached-esm',
		setup(builder) {
			builder.onResolve({ filter: /.*/ }, (args) => {
				const entry = imports.get(args.path)
				if (entry) return { path: entry, namespace: 'cdn' }
				if (args.namespace !== 'cdn') return
				const url = new URL(args.path, args.importer).href
				return modules.has(url)
					? { path: url, namespace: 'cdn' }
					: { errors: [{ text: `module is not cached: ${url}` }] }
			})
			builder.onLoad({ filter: /.*/, namespace: 'cdn' }, (args) => ({
				contents: modules.get(args.path),
				loader: 'js'
			}))
		}
	}
}

function memoryCache(): ImportCache {
	const values = new Map<string, CachedImport>()
	return {
		async get(url) {
			return values.get(url)
		},
		async put(url, value) {
			values.set(url, { ...value })
		}
	}
}

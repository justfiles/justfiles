import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { strFromU8, unzipSync } from 'fflate'
import { expect, test } from 'vitest'
import type { Kernel } from '../../kernel.ts'
import { sdkRuntimeSpecs } from '../../runtime-specs.ts'
import { DEVKIT_SCHEMA } from './devkit-sysroot.ts'
import { devkitCapability, noopRunner } from './host.ts'
import type { CachedImport, ImportCache, ResolvedImports } from './imports.ts'
import type { CompileResult } from './toolchain.ts'

// Step 5: the devkit factory is caller-aware. The shared `devkitCapability`
// pipeline threads the calling app's id (`ctx.appId`) into every method, so it
// loads THAT caller's own sysroot via `kernel().app(ctx.appId)` rather than a
// hardcoded one. These tests pin the threading — we only prove the right appId
// reaches the kernel resolution.

const enc = new TextEncoder()
const empty: CompileResult = { outputs: [], diagnostics: [] }

// Seed a trivial project for `appId` so `readProject` (which runs before the
// toolchain is reached) succeeds — we only care which appId the factory gets.
async function seed(
	fs: ReturnType<typeof volume>,
	appId: string,
	slug: string,
	project: Record<string, unknown> = { id: 'app.x', name: 'X', app: 'app.ts' }
): Promise<void> {
	const root = `/data/${appId}/projects/${slug}`
	await fs.mkdir(root, { recursive: true })
	await fs.writeFile(`${root}/project.json`, enc.encode(JSON.stringify(project)))
	await fs.writeFile(`${root}/app.ts`, enc.encode('export const app = {}'))
	if (typeof project.gui === 'string') {
		await fs.writeFile(`${root}/${project.gui}`, enc.encode('export const gui = {}'))
	}
}

// A devkit capability whose fake kernel records every app id the factory resolves a
// sysroot for. `read` serves a stub devkit sysroot so loadRuntime/loadTypes succeed;
// the compile/typecheck backends return empty results — we only care which appId
// reaches `kernel().app()`. The runtime map lists every SDK spec (pointing at one
// empty blob), because `loadRuntime` rejects an incomplete sysroot.
const STUB = 'stub'
function harness(
	backends: Partial<Pick<Parameters<typeof devkitCapability>[0], 'compile' | 'typecheck'>> = {}
) {
	const fs = volume(memStore())
	const seen: string[] = []
	const index = enc.encode(
		JSON.stringify({
			schema: DEVKIT_SCHEMA,
			hash: 'x',
			files: {},
			runtime: Object.fromEntries(sdkRuntimeSpecs.map((spec) => [`${spec}.js`, STUB])),
			paths: {}
		})
	)
	const read = async (path: string) => {
		if (path === 'devkit/index.json') return index
		if (path === `devkit/store/${STUB}`) return enc.encode('export {}')
		throw new Error(`not found: ${path}`)
	}
	const installed: unknown[] = []
	const kernel = {
		app: async (appId: string) => {
			seen.push(appId)
			return { read }
		},
		list: async () => [],
		install: async (bundle: unknown) => {
			installed.push(bundle)
		}
	} as unknown as Kernel
	const impl = devkitCapability({
		fs,
		kernel,
		compile: backends.compile ?? (async () => empty),
		typecheck: backends.typecheck ?? (async () => ({ diagnostics: [] })),
		runner: noopRunner
	})
	const call = (appId: string, method: string, args: readonly unknown[]) =>
		impl.invoke({ appId, capability: 'devkit', method, args, scopes: [] })
	return { fs, seen, installed, call, kernel }
}

test('compile resolves the toolchain for the calling app', async () => {
	const { fs, seen, call } = harness()
	await seed(fs, 'justfiles.code', 'draft')
	await call('justfiles.code', 'compile', [{ slug: 'draft' }])
	expect(seen).toEqual(['justfiles.code'])
})

test('each caller resolves its own toolchain — no hardcoded app id', async () => {
	const { fs, seen, call } = harness()
	await seed(fs, 'justfiles.code', 'a')
	await seed(fs, 'app.other', 'b')
	await call('justfiles.code', 'compile', [{ slug: 'a' }])
	await call('app.other', 'typecheck', [{ slug: 'b' }])
	expect(seen).toEqual(['justfiles.code', 'app.other'])
})

test('runs one operation at a time for each project', async () => {
	const calls: string[] = []
	let start!: () => void
	const started = new Promise<void>((resolve) => {
		start = resolve
	})
	let release!: () => void
	const blocked = new Promise<void>((resolve) => {
		release = resolve
	})
	const { fs, call } = harness({
		compile: async () => {
			calls.push('compile')
			start()
			await blocked
			throw new Error('compile failed')
		},
		typecheck: async () => {
			calls.push('typecheck')
			return { diagnostics: [] }
		}
	})
	await seed(fs, 'justfiles.code', 'draft')

	const compiling = call('justfiles.code', 'compile', [{ slug: 'draft' }])
	await started
	const checking = call('justfiles.code', 'typecheck', [{ slug: 'draft' }])
	await new Promise((resolve) => setTimeout(resolve, 0))
	const whileCompiling = [...calls]
	release()
	const results = await Promise.allSettled([compiling, checking])

	expect(whileCompiling).toEqual(['compile'])
	expect(calls).toEqual(['compile', 'typecheck'])
	expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled'])
})

test('all project operations reuse one import session and update its lock', async () => {
	const { fs, installed, kernel } = harness()
	const cache = memoryCache()
	const graphs: ResolvedImports[] = []
	const source = 'https://esm.sh/example@1.0.0'
	const code = 'https://esm.sh/example@1.0.0/es2022/example.mjs'
	const types = 'https://esm.sh/example@1.0.0/index.d.ts'
	const responses: Record<string, string> = {
		[`${source}?meta`]: JSON.stringify({ module: code, dts: types }),
		[code]: 'remote marker',
		[types]: 'export declare const marker: string'
	}
	const fetch = async (input: string | URL | Request) => {
		const url = String(input)
		const body = responses[url]
		if (!body) return response(url, 'not found', 404)
		return response(url, body)
	}
	const impl = devkitCapability({
		fs,
		kernel,
		imports: { cache, fetch },
		compile: async (input, _runtime, imports) => {
			graphs.push(imports!)
			const remote = await imports!.load(imports!.code.example!)
			return {
				outputs: Object.keys(input.entries).map((name) => ({
					path: `${name}.js`,
					text: `export default ${JSON.stringify(remote.text)}`
				})),
				diagnostics: []
			}
		},
		typecheck: async (_input, _types, _paths, imports) => {
			graphs.push(imports!)
			await imports!.load(imports!.declarations.example!)
			return { diagnostics: [] }
		},
		runner: noopRunner,
		overwrite: true
	})
	const call = (method: string) =>
		impl.invoke({
			appId: 'justfiles.code',
			capability: 'devkit',
			method,
			args: [{ slug: 'react' }],
			scopes: []
		})
	await seed(fs, 'justfiles.code', 'react', {
		id: 'app.react',
		name: 'React',
		app: 'app.ts',
		gui: 'gui.ts',
		imports: { example: source }
	})

	await call('compile')
	await call('typecheck')
	await call('run')
	const packed = (await call('pack')) as { zip: Uint8Array }
	await call('install')

	expect(new Set(graphs).size).toBe(1)
	const lock = JSON.parse(
		new TextDecoder().decode(
			await fs.readFile('/data/justfiles.code/projects/react/devkit-lock.json')
		)
	)
	expect(lock.remote).toHaveProperty(code)
	expect(lock.remote).toHaveProperty(types)
	const zip = unzipSync(packed.zip)
	const app = strFromU8(zip['app.js']!)
	expect(app).toContain('remote marker')
	expect(strFromU8(zip['gui.js']!)).toContain('remote marker')
	expect(installed).toHaveLength(1)
	const ran = (await import(`data:text/javascript,${encodeURIComponent(app)}`)) as unknown
	expect(typeof ran === 'string' ? ran : (ran as { default: string }).default).toBe('remote marker')

	let requests = 0
	const offline = devkitCapability({
		fs,
		kernel,
		imports: {
			cache,
			fetch: async () => {
				requests++
				throw new Error('offline')
			}
		},
		compile: async (input, _runtime, imports) => {
			const remote = await imports!.load(imports!.code.example!)
			return {
				outputs: Object.keys(input.entries).map((name) => ({
					path: `${name}.js`,
					text: remote.text
				})),
				diagnostics: []
			}
		},
		runner: noopRunner
	})
	const offlineResult = (await offline.invoke({
		appId: 'justfiles.code',
		capability: 'devkit',
		method: 'compile',
		args: [{ slug: 'react' }],
		scopes: []
	})) as CompileResult
	expect(offlineResult.diagnostics).toEqual([])
	expect(requests).toBe(0)
})

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

function response(url: string, body: string, status = 200): Response {
	const value = new Response(body, { status })
	Object.defineProperty(value, 'url', { value: url })
	return value
}

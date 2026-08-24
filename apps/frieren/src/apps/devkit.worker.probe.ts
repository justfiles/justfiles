import {
	type CheckResult,
	type CompileResult,
	devkitCapability,
	type ImportCache,
	noopRunner
} from '@justfiles/app/capabilities/devkit/host'
import type { Kernel } from '@justfiles/app/runtime'
import { sdkRuntimeSpecs } from '@justfiles/app/runtime-specs'
import { type Volume, volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { strFromU8, unzipSync } from 'fflate'
import {
	frierenCompile,
	frierenImports,
	frierenTypecheck,
	resetDevkitWorker
} from './devkit.client'

type ProbeResult = {
	checks: Record<string, boolean>
	metrics: {
		fixtureFiles: number
		fixtureBytes: number
		downloadRequests: number
		downloadMs: number
		compileMs: number
		firstTypecheckMs: number
		repeatTypecheckMs: number
		offlineMs: number
		mainThreadLongTasks: number
		longestMainThreadTaskMs: number
	}
	details: {
		compileErrors: string[]
		typeErrors: string[]
		badTypeErrors: string[]
		failureErrors: Record<string, string[]>
		lockEntries: number
		offlineFlow: Record<string, unknown>
		offlineRequests: number
		workerFailure: string
	}
}

declare global {
	var __DEVKIT_PROBE__: Promise<ProbeResult>
}

const APP_ID = 'justfiles.code'
const SLUG = 'worker-probe'
const CACHE = 'justfiles-devkit-imports-v1'
const encoder = new TextEncoder()
const react = 'https://esm.sh/react@19.1.1'
const reactJsx = 'https://esm.sh/react@19.1.1/jsx-runtime'
const reactDom = 'https://esm.sh/react-dom@19.1.1/client?bundle&deps=react@19.1.1'

globalThis.__DEVKIT_PROBE__ = run()

async function run(): Promise<ProbeResult> {
	resetDevkitWorker()
	await caches.delete(CACHE)
	const fs = volume(memStore())
	const files = fixture()
	const root = `/data/${APP_ID}/projects/${SLUG}`
	await fs.mkdir(`${root}/src`, { recursive: true })
	for (const [path, source] of Object.entries(files)) {
		await fs.writeFile(`${root}/${path}`, encoder.encode(source))
	}
	await fs.writeFile(
		`${root}/project.json`,
		encoder.encode(
			JSON.stringify({
				id: 'app.worker-probe',
				name: 'Worker probe',
				app: 'src/app.ts',
				gui: 'src/gui.tsx',
				compiler: { jsx: 'react-jsx' },
				imports: {
					react,
					'react/jsx-runtime': reactJsx,
					'react-dom/client': reactDom
				}
			})
		)
	)

	const { kernel, installed } = probeKernel()
	let downloadRequests = 0
	let downloadMs = 0
	const measuredFetch: typeof fetch = async (input, init) => {
		downloadRequests++
		const started = performance.now()
		try {
			return await fetch(input, init)
		} finally {
			downloadMs += performance.now() - started
		}
	}
	const online = devkitCapability({
		fs,
		kernel,
		compile: frierenCompile,
		typecheck: frierenTypecheck,
		imports: { ...frierenImports, fetch: measuredFetch },
		runner: noopRunner
	})
	const longTasks: number[] = []
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) longTasks.push(entry.duration)
	})
	observer.observe({ type: 'longtask' })

	const compileStarted = performance.now()
	const compiled = (await probeStep('online compile', invoke(online, 'compile'))) as CompileResult
	const compileMs = performance.now() - compileStarted
	const firstStarted = performance.now()
	const checked = (await probeStep('first typecheck', invoke(online, 'typecheck'))) as CheckResult
	const firstTypecheckMs = performance.now() - firstStarted
	const repeatStarted = performance.now()
	const repeated = (await probeStep('repeat typecheck', invoke(online, 'typecheck'))) as CheckResult
	const repeatTypecheckMs = performance.now() - repeatStarted

	await fs.writeFile(
		`${root}/src/card-0.tsx`,
		encoder.encode(`${files['src/card-0.tsx']}\nexport const broken: string = 42\n`)
	)
	const bad = (await probeStep('error typecheck', invoke(online, 'typecheck'))) as CheckResult
	await fs.writeFile(`${root}/src/card-0.tsx`, encoder.encode(files['src/card-0.tsx'] ?? ''))
	const lock = JSON.parse(
		new TextDecoder().decode(await fs.readFile(`${root}/devkit-lock.json`))
	) as {
		remote: Record<string, string>
	}

	resetDevkitWorker()
	let offlineRequests = 0
	const offline = devkitCapability({
		fs,
		kernel,
		compile: frierenCompile,
		typecheck: frierenTypecheck,
		imports: {
			...frierenImports,
			fetch: async () => {
				offlineRequests++
				throw new Error('offline')
			}
		},
		runner: noopRunner
	})
	const offlineStarted = performance.now()
	const offlineCompile = (await probeStep(
		'offline compile',
		invoke(offline, 'compile')
	)) as CompileResult
	const offlineCheck = (await probeStep(
		'offline typecheck',
		invoke(offline, 'typecheck')
	)) as CheckResult
	const offlineRun = (await probeStep('offline run', invoke(offline, 'run'))) as {
		diagnostics: string[]
	}
	const packed = (await probeStep('offline pack', invoke(offline, 'pack'))) as { zip: Uint8Array }
	const installedResult = (await probeStep('offline install', invoke(offline, 'install'))) as {
		id: string
	}
	const offlineMs = performance.now() - offlineStarted
	const zip = unzipSync(packed.zip)
	const packedGui = strFromU8(zip['gui.js'] ?? new Uint8Array())
	const packedGuiHasCdnImport = /(?:from\s*|import\()["']https:\/\/esm\.sh/.test(packedGui)

	const interrupted = frierenTypecheck(
		{
			files: { 'app.ts': 'export const app = {}' },
			entries: { app: 'app.ts' },
			tsconfig: { compilerOptions: { noEmit: true } }
		},
		{},
		{}
	)
	resetDevkitWorker()
	const workerFailure = await interrupted.then(
		() => '',
		(error: unknown) => (error instanceof Error ? error.message : String(error))
	)
	const restarted = (await probeStep(
		'restarted compile',
		invoke(offline, 'compile')
	)) as CompileResult
	const failures = await checkFailures(fs, kernel)
	await new Promise((resolve) => setTimeout(resolve, 50))
	observer.disconnect()

	const compileErrors = errors(compiled.diagnostics)
	const typeErrors = errors(checked.diagnostics)
	const repeatedErrors = errors(repeated.diagnostics)
	const badTypeErrors = errors(bad.diagnostics)
	const gui = compiled.outputs.find((output) => output.path === 'gui.js')?.text ?? ''
	const remote = Object.keys(lock.remote)
	return {
		checks: {
			compileSucceeded: compileErrors.length === 0 && gui.includes('Devkit worker probe'),
			typecheckSucceeded: typeErrors.length === 0,
			repeatTypecheckSucceeded: repeatedErrors.length === 0,
			typeErrorReported: bad.diagnostics.some((item) => item.code === 'TS2322'),
			lockHasCodeAndTypes:
				remote.some((url) => url.includes('/react@19.1.1/') && url.endsWith('.mjs')) &&
				remote.some((url) => url.endsWith('.d.ts')),
			offlineCacheSucceeded:
				errors(offlineCompile.diagnostics).length === 0 &&
				errors(offlineCheck.diagnostics).length === 0 &&
				offlineRun.diagnostics.length === 0 &&
				installedResult.id === 'app.worker-probe' &&
				installed.length === 1 &&
				packedGui.includes('Devkit worker probe') &&
				!packedGuiHasCdnImport &&
				offlineRequests === 0,
			workerRestartedAfterFailure:
				workerFailure === 'Devkit worker stopped' && errors(restarted.diagnostics).length === 0,
			...failures.checks,
			mainThreadStayedResponsive: longTasks.length === 0,
			firstTypecheckWithinTarget: firstTypecheckMs < 5_000,
			repeatTypecheckWithinTarget: repeatTypecheckMs < 2_000
		},
		metrics: {
			fixtureFiles: Object.keys(files).length,
			fixtureBytes: Object.values(files).reduce(
				(total, source) => total + encoder.encode(source).byteLength,
				0
			),
			downloadRequests,
			downloadMs: round(downloadMs),
			compileMs: round(compileMs),
			firstTypecheckMs: round(firstTypecheckMs),
			repeatTypecheckMs: round(repeatTypecheckMs),
			offlineMs: round(offlineMs),
			mainThreadLongTasks: longTasks.length,
			longestMainThreadTaskMs: round(Math.max(0, ...longTasks))
		},
		details: {
			compileErrors,
			typeErrors,
			badTypeErrors,
			failureErrors: failures.errors,
			lockEntries: remote.length,
			offlineFlow: {
				compileErrors: errors(offlineCompile.diagnostics),
				typeErrors: errors(offlineCheck.diagnostics),
				runDiagnostics: offlineRun.diagnostics,
				installedId: installedResult.id,
				installedCount: installed.length,
				packedGuiHasMarker: packedGui.includes('Devkit worker probe'),
				packedGuiHasCdnImport
			},
			offlineRequests,
			workerFailure
		}
	}
}

async function checkFailures(
	fs: Volume,
	kernel: Kernel
): Promise<{ checks: Record<string, boolean>; errors: Record<string, string[]> }> {
	const timeoutSource = 'https://esm.sh/devkit-timeout@1.0.0'
	await seedImportProject(fs, 'timeout', 'devkit-timeout', timeoutSource)
	const timeout = await diagnosticErrors(
		capability(fs, kernel, memoryCache(), async () => {
			throw new DOMException('The operation timed out.', 'TimeoutError')
		}),
		'compile',
		'timeout'
	)

	const redirectSource = 'https://esm.sh/devkit-redirect@1.0.0'
	await seedImportProject(fs, 'redirect', 'devkit-redirect', redirectSource)
	const redirect = await diagnosticErrors(
		capability(fs, kernel, memoryCache(), async () => {
			throw new TypeError('redirect count exceeded')
		}),
		'compile',
		'redirect'
	)

	const lockedSource = 'https://esm.sh/devkit-locked@1.0.0'
	const lockedModule = 'https://esm.sh/devkit-locked@1.0.0/es2022/devkit-locked.mjs'
	await seedImportProject(fs, 'locked', 'devkit-locked', lockedSource)
	const lockedFiles = {
		[`${lockedSource}?meta`]: JSON.stringify({ module: lockedModule }),
		[lockedModule]: "export const marker = 'first'"
	}
	const firstLocked = await diagnosticErrors(
		capability(fs, kernel, memoryCache(), fakeFetch(lockedFiles)),
		'compile',
		'locked'
	)
	const changed = await diagnosticErrors(
		capability(
			fs,
			kernel,
			memoryCache(),
			fakeFetch({ ...lockedFiles, [lockedModule]: "export const marker = 'changed'" })
		),
		'compile',
		'locked'
	)

	const corruptSource = 'https://esm.sh/devkit-corrupt@1.0.0'
	await seedImportProject(fs, 'corrupt', 'devkit-corrupt', corruptSource)
	await (await caches.open(CACHE)).put(`${corruptSource}?meta`, new Response('{}'))
	const corrupt = await diagnosticErrors(
		capability(fs, kernel, frierenImports.cache, async () => {
			throw new Error('corrupt cache must not use the network')
		}),
		'compile',
		'corrupt'
	)

	const missingSource = 'https://esm.sh/devkit-missing-types@1.0.0'
	const missingModule = 'https://esm.sh/devkit-missing-types@1.0.0/es2022/missing.mjs'
	await seedImportProject(fs, 'missing-types', 'devkit-missing-types', missingSource)
	const missingTypes = await diagnosticErrors(
		capability(
			fs,
			kernel,
			memoryCache(),
			fakeFetch({
				[`${missingSource}?meta`]: JSON.stringify({ module: missingModule }),
				[missingModule]: "export const marker = 'ok'"
			})
		),
		'typecheck',
		'missing-types'
	)

	const nodeSource = 'https://esm.sh/devkit-node@1.0.0'
	const nodeModule = 'https://esm.sh/devkit-node@1.0.0/es2022/devkit-node.mjs'
	await seedImportProject(fs, 'node', 'devkit-node', nodeSource)
	const node = await diagnosticErrors(
		capability(
			fs,
			kernel,
			memoryCache(),
			fakeFetch({
				[`${nodeSource}?meta`]: JSON.stringify({ module: nodeModule }),
				[nodeModule]: 'export { readFile as marker } from "/node/fs.mjs"'
			})
		),
		'compile',
		'node'
	)

	const failureErrors = { timeout, redirect, firstLocked, changed, corrupt, missingTypes, node }
	return {
		checks: {
			cdnTimeoutReported: timeout.some((message) => /timed out|timeout/i.test(message)),
			redirectLoopReported: redirect.some((message) => message.includes('redirect count exceeded')),
			lockedBodyChangeReported:
				firstLocked.length === 0 && changed.some((message) => message.includes('devkit-lock.json')),
			corruptCacheReported: corrupt.some((message) =>
				message.includes('Invalid Devkit import cache')
			),
			missingTypesReported: missingTypes.some((message) => message.includes('TS2307')),
			unsupportedNodeImportReported: node.some((message) =>
				message.includes('Node import is not supported')
			)
		},
		errors: failureErrors
	}
}

function fixture(): Record<string, string> {
	const files: Record<string, string> = {
		'src/app.ts': `export const app = { initialState: { ready: true } }`,
		'src/gui.tsx': ''
	}
	const imports: string[] = []
	const cards: string[] = []
	for (let index = 0; index < 40; index++) {
		const name = `Card${index}`
		imports.push(`import { ${name} } from './card-${index}'`)
		cards.push(`<${name} index={${index}} />`)
		files[`src/card-${index}.tsx`] = `type Props = { index: number; label?: string }
export function ${name}({ index, label = 'Item ${index}' }: Props) {
	return <article data-index={index}><strong>{label}</strong><span>{index * 2}</span></article>
}`
	}
	files['src/gui.tsx'] = `import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
${imports.join('\n')}
function Probe() {
	const [filter, setFilter] = useState('')
	const cards = useMemo(() => [${cards.join(',')}], [])
	return <main><h1>Devkit worker probe</h1><input value={filter} onChange={(event) => setFilter(event.target.value)} />{cards}</main>
}
createRoot(document.getElementById('root')!).render(<Probe />)`
	return files
}

function probeKernel(): { kernel: Kernel; installed: unknown[] } {
	const stub = 'stub'
	const installed: unknown[] = []
	const index = encoder.encode(
		JSON.stringify({
			schema: 'justfiles.devkit.v1',
			hash: 'probe',
			files: {},
			runtime: Object.fromEntries(sdkRuntimeSpecs.map((specifier) => [`${specifier}.js`, stub])),
			paths: {}
		})
	)
	const kernel = {
		app: async () => ({
			read: async (path: string) => {
				if (path === 'devkit/index.json') return index
				if (path === `devkit/store/${stub}`) return encoder.encode('export {}')
				throw new Error(`not found: ${path}`)
			}
		}),
		list: async () => [],
		install: async (bundle: unknown) => {
			installed.push(bundle)
		}
	} as unknown as Kernel
	return { kernel, installed }
}

function capability(
	fs: Volume,
	kernel: Kernel,
	cache: ImportCache,
	fetch: typeof globalThis.fetch
) {
	return devkitCapability({
		fs,
		kernel,
		compile: frierenCompile,
		typecheck: frierenTypecheck,
		imports: { cache, fetch },
		runner: noopRunner
	})
}

async function seedImportProject(
	fs: Volume,
	slug: string,
	specifier: string,
	source: string
): Promise<void> {
	const root = `/data/${APP_ID}/projects/${slug}`
	await fs.mkdir(`${root}/src`, { recursive: true })
	await fs.writeFile(
		`${root}/project.json`,
		encoder.encode(
			JSON.stringify({
				id: `app.worker-probe.${slug}`,
				name: `Worker probe ${slug}`,
				app: 'src/app.ts',
				gui: 'src/gui.ts',
				imports: { [specifier]: source }
			})
		)
	)
	await fs.writeFile(
		`${root}/src/app.ts`,
		encoder.encode(`import { marker } from '${specifier}'; export const app = marker`)
	)
	await fs.writeFile(`${root}/src/gui.ts`, encoder.encode('export const gui = {}'))
}

function memoryCache(): ImportCache {
	const values = new Map<string, { url: string; text: string }>()
	return {
		async get(url) {
			const value = values.get(url)
			return value ? { ...value } : undefined
		},
		async put(url, value) {
			values.set(url, { ...value })
		}
	}
}

function fakeFetch(values: Record<string, string>): typeof globalThis.fetch {
	return async (input) => {
		const url = String(input)
		const body = values[url]
		return response(url, body ?? 'not found', body === undefined ? 404 : 200)
	}
}

function response(url: string, body: string, status: number): Response {
	const value = new Response(body, { status })
	Object.defineProperty(value, 'url', { value: url })
	return value
}

async function diagnosticErrors(
	capability: ReturnType<typeof devkitCapability>,
	method: 'compile' | 'typecheck',
	slug: string
): Promise<string[]> {
	try {
		const result = (await invoke(capability, method, slug)) as CheckResult
		return errors(result.diagnostics)
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)]
	}
}

function invoke(
	capability: ReturnType<typeof devkitCapability>,
	method: string,
	slug = SLUG
): Promise<unknown> {
	return capability.invoke({
		appId: APP_ID,
		capability: 'devkit',
		method,
		args: [{ slug }],
		scopes: []
	})
}

function errors(diagnostics: CheckResult['diagnostics']): string[] {
	return diagnostics
		.filter((item) => item.severity === 'error')
		.map((item) => `${item.code ?? item.source}: ${item.message}`)
}

async function probeStep<T>(name: string, task: Promise<T>): Promise<T> {
	try {
		return await task
	} catch (error) {
		throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function round(value: number): number {
	return Math.round(value * 10) / 10
}

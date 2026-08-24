import {
	type CheckResult,
	type CompileResult,
	devkitCapability,
	noopRunner
} from '@justfiles/app/capabilities/devkit/host'
import type { Kernel } from '@justfiles/app/runtime'
import { sdkRuntimeSpecs } from '@justfiles/app/runtime-specs'
import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
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
		lockEntries: number
		offlineRequests: number
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

	const kernel = probeKernel()
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
	const compiled = (await invoke(online, 'compile')) as CompileResult
	const compileMs = performance.now() - compileStarted
	const firstStarted = performance.now()
	const checked = (await invoke(online, 'typecheck')) as CheckResult
	const firstTypecheckMs = performance.now() - firstStarted
	const repeatStarted = performance.now()
	const repeated = (await invoke(online, 'typecheck')) as CheckResult
	const repeatTypecheckMs = performance.now() - repeatStarted

	await fs.writeFile(
		`${root}/src/card-0.tsx`,
		encoder.encode(`${files['src/card-0.tsx']}\nexport const broken: string = 42\n`)
	)
	const bad = (await invoke(online, 'typecheck')) as CheckResult
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
	const offlineCompile = (await invoke(offline, 'compile')) as CompileResult
	const offlineCheck = (await invoke(offline, 'typecheck')) as CheckResult
	const offlineMs = performance.now() - offlineStarted
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
				offlineRequests === 0,
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
			lockEntries: remote.length,
			offlineRequests
		}
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

function probeKernel(): Kernel {
	const stub = 'stub'
	const index = encoder.encode(
		JSON.stringify({
			schema: 'justfiles.devkit.v1',
			hash: 'probe',
			files: {},
			runtime: Object.fromEntries(sdkRuntimeSpecs.map((specifier) => [`${specifier}.js`, stub])),
			paths: {}
		})
	)
	return {
		app: async () => ({
			read: async (path: string) => {
				if (path === 'devkit/index.json') return index
				if (path === `devkit/store/${stub}`) return encoder.encode('export {}')
				throw new Error(`not found: ${path}`)
			}
		}),
		list: async () => [],
		install: async () => {}
	} as unknown as Kernel
}

function invoke(capability: ReturnType<typeof devkitCapability>, method: string): Promise<unknown> {
	return capability.invoke({
		appId: APP_ID,
		capability: 'devkit',
		method,
		args: [{ slug: SLUG }],
		scopes: []
	})
}

function errors(diagnostics: CheckResult['diagnostics']): string[] {
	return diagnostics
		.filter((item) => item.severity === 'error')
		.map((item) => `${item.code ?? item.source}: ${item.message}`)
}

function round(value: number): number {
	return Math.round(value * 10) / 10
}

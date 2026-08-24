import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Browser, chromium, firefox, webkit } from '@playwright/test'
import { build, preview } from 'vite'

type Result = {
	checks: Record<string, boolean>
	metrics: Record<string, number>
	details: Record<string, unknown>
}

const ENGINES = { chromium, firefox, webkit }
type EngineName = keyof typeof ENGINES
type EngineResult = {
	engine: EngineName
	status: 'pass' | 'fail' | 'skip'
	result?: Result
	note?: string
}

const root = path.resolve(import.meta.dirname, '..')
const outDir = await mkdtemp(path.join(tmpdir(), 'frieren-devkit-worker-'))
let server: Awaited<ReturnType<typeof preview>> | undefined

try {
	await build({
		configFile: false,
		logLevel: 'warn',
		root,
		resolve: { alias: { '@': path.resolve(root, 'src') } },
		worker: { format: 'es' },
		build: {
			emptyOutDir: true,
			outDir,
			rollupOptions: { input: path.join(root, 'devkit-worker-probe.html') }
		}
	})
	server = await preview({
		configFile: false,
		root,
		build: { outDir },
		preview: { host: '127.0.0.1', port: 0 }
	})
	const address = server.httpServer.address()
	if (!address || typeof address === 'string') throw new Error('Probe server did not start')
	const assets = await readdir(path.join(outDir, 'assets'))
	const worker = assets.find((file) => file.startsWith('devkit.toolchain.worker-'))
	const typescript = assets.find((file) => file.startsWith('devkit.toolchain.typescript-'))
	const html = await readFile(path.join(outDir, 'devkit-worker-probe.html'), 'utf8')
	const url = `http://127.0.0.1:${address.port}/devkit-worker-probe.html`
	const engines = parseEngines()
	const enforcePerformance = engines.length === 1 && engines[0] === 'chromium'
	const results: EngineResult[] = []
	for (const engine of engines) {
		results.push(await runEngine(engine, url, { worker, typescript, html }, enforcePerformance))
	}
	console.log(JSON.stringify(results, null, 2))
	if (results.some((result) => result.status !== 'pass')) process.exitCode = 1
} finally {
	await server?.close()
	await rm(outDir, { force: true, recursive: true })
}

function parseEngines(): EngineName[] {
	const value = process.argv[2]
	if (!value || value === 'all') return Object.keys(ENGINES) as EngineName[]
	if (value in ENGINES) return [value as EngineName]
	throw new Error(`Unknown browser engine: ${value}`)
}

async function runEngine(
	engine: EngineName,
	url: string,
	assets: { worker?: string; typescript?: string; html: string },
	enforcePerformance: boolean
): Promise<EngineResult> {
	let browser: Browser | undefined
	try {
		browser = await ENGINES[engine].launch(
			engine === 'chromium' ? { args: ['--enable-precise-memory-info'] } : {}
		)
	} catch (error) {
		return { engine, status: 'skip', note: message(error).split('\n')[0] }
	}
	const browserErrors: string[] = []
	try {
		const page = await browser.newPage()
		page.on('console', (entry) => {
			if (entry.type() === 'error') browserErrors.push(entry.text())
		})
		page.on('pageerror', (error) => browserErrors.push(error.message))
		await page.goto(url)
		const result = await page.evaluate(
			() => (globalThis as unknown as { __DEVKIT_PROBE__: Promise<Result> }).__DEVKIT_PROBE__
		)
		result.checks.typeScriptIsLazy = Boolean(
			assets.worker && assets.typescript && !assets.html.includes(assets.typescript)
		)
		result.checks.browserHadNoErrors = browserErrors.length === 0
		if (!enforcePerformance) {
			result.details.performanceTargets = {
				firstTypecheckWithinTarget: result.checks.firstTypecheckWithinTarget,
				repeatTypecheckWithinTarget: result.checks.repeatTypecheckWithinTarget
			}
			delete result.checks.firstTypecheckWithinTarget
			delete result.checks.repeatTypecheckWithinTarget
		}
		if (engine === 'chromium') {
			const memoryMb = await workerMemoryMb(browser)
			if (enforcePerformance) {
				result.checks.workerMemoryWithinTarget = memoryMb !== undefined && memoryMb < 250
			}
			result.metrics.workerMemoryMb = memoryMb ?? -1
		}
		result.details.browser = await page.evaluate(() => navigator.userAgent)
		result.details.machine = `${process.platform} ${process.arch}`
		result.details.workerChunk = assets.worker ?? 'missing'
		result.details.typeScriptChunk = assets.typescript ?? 'missing'
		result.details.browserErrors = browserErrors
		return {
			engine,
			status: Object.values(result.checks).every(Boolean) ? 'pass' : 'fail',
			result
		}
	} catch (error) {
		return { engine, status: 'fail', note: `${message(error)} ${JSON.stringify(browserErrors)}` }
	} finally {
		await browser.close()
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

async function workerMemoryMb(browser: Browser): Promise<number | undefined> {
	const session = await browser.newBrowserCDPSession()
	const { targetInfos } = await session.send('Target.getTargets')
	const target = targetInfos.find(
		(item) => item.type === 'worker' && item.url.includes('devkit.toolchain.worker')
	)
	if (!target) return
	const attached = await session.send('Target.attachToTarget', {
		targetId: target.targetId,
		flatten: false
	})
	const id = 1
	const response = new Promise<{
		result?: {
			totalSize?: number
			embedderHeapUsedSize?: number
			backingStorageSize?: number
		}
	}>((resolve) => {
		session.on('Target.receivedMessageFromTarget', (event) => {
			if (event.sessionId !== attached.sessionId) return
			const message = JSON.parse(event.message) as {
				id?: number
				result?: {
					totalSize?: number
					embedderHeapUsedSize?: number
					backingStorageSize?: number
				}
			}
			if (message.id === id) resolve(message)
		})
	})
	await session.send('Target.sendMessageToTarget', {
		sessionId: attached.sessionId,
		message: JSON.stringify({ id, method: 'Runtime.getHeapUsage' })
	})
	const memory = (await response).result
	await session.send('Target.detachFromTarget', { sessionId: attached.sessionId })
	if (!memory?.totalSize) return
	const bytes =
		memory.totalSize + (memory.embedderHeapUsedSize ?? 0) + (memory.backingStorageSize ?? 0)
	return Math.round((bytes / 1024 / 1024) * 10) / 10
}

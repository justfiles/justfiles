import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Browser, chromium } from '@playwright/test'
import { build, preview } from 'vite'

type Result = {
	checks: Record<string, boolean>
	metrics: Record<string, number>
	details: Record<string, unknown>
}

const root = path.resolve(import.meta.dirname, '..')
const outDir = await mkdtemp(path.join(tmpdir(), 'frieren-devkit-worker-'))
let server: Awaited<ReturnType<typeof preview>> | undefined
let browser: Browser | undefined

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
	browser = await chromium.launch({ args: ['--enable-precise-memory-info'] })
	const page = await browser.newPage()
	const browserErrors: string[] = []
	page.on('console', (message) => {
		if (message.type() === 'error') browserErrors.push(message.text())
	})
	page.on('pageerror', (error) => browserErrors.push(error.message))
	await page.goto(`http://127.0.0.1:${address.port}/devkit-worker-probe.html`)
	const result = await page.evaluate(
		() => (globalThis as unknown as { __DEVKIT_PROBE__: Promise<Result> }).__DEVKIT_PROBE__
	)
	const memoryMb = await workerMemoryMb(browser)
	const assets = await readdir(path.join(outDir, 'assets'))
	const worker = assets.find((file) => file.startsWith('devkit.toolchain.worker-'))
	const typescript = assets.find((file) => file.startsWith('devkit.toolchain.typescript-'))
	const html = await readFile(path.join(outDir, 'devkit-worker-probe.html'), 'utf8')
	result.checks.typeScriptIsLazy = Boolean(worker && typescript && !html.includes(typescript))
	result.checks.workerMemoryWithinTarget = memoryMb !== undefined && memoryMb < 250
	result.checks.browserHadNoErrors = browserErrors.length === 0
	result.metrics.workerMemoryMb = memoryMb ?? -1
	result.details.browser = await page.evaluate(() => navigator.userAgent)
	result.details.machine = `${process.platform} ${process.arch}`
	result.details.workerChunk = worker ?? 'missing'
	result.details.typeScriptChunk = typescript ?? 'missing'
	result.details.browserErrors = browserErrors

	console.log(JSON.stringify(result, null, 2))
	if (Object.values(result.checks).some((passed) => !passed)) process.exitCode = 1
} finally {
	await browser?.close()
	await server?.close()
	await rm(outDir, { force: true, recursive: true })
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

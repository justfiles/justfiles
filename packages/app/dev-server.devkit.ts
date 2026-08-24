import type { IncomingMessage, ServerResponse } from 'node:http'
import { Worker } from 'node:worker_threads'
import type { Volume } from '@justfiles/fs'
import { appBundleFromMemory, type Message } from './app.ts'
import { devkitCapability, type Runner } from './capabilities/devkit/host.ts'
import { diskImportCache } from './capabilities/devkit/imports.node.ts'
import { esbuildCompile } from './capabilities/devkit/toolchain.esbuild.ts'
import { tsTypecheckImports } from './capabilities/devkit/toolchain.typescript.ts'
import type { Capability } from './capabilities/types.ts'
import type { GetSandbox, Kernel, Sandbox } from './kernel.ts'
import { sandboxClient, sandboxWorkerSource } from './sandbox.ts'

type Cell = { code: string; sandbox: Sandbox; stop: (error: Error) => void }

export function devkitHost(fs: Volume): {
	sandbox: GetSandbox
	capability(kernel: Kernel): Capability
	handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>
	close(): void
} {
	const workers = workerPool()
	const imports = { cache: diskImportCache() }
	const previews = new Map<string, string>()
	let kernel: Kernel
	const runner: Runner = {
		mount: async (draft, { previewId, reset }) => {
			if (reset) await fs.rm(`/state/${previewId}.json`, { force: true })
			await kernel.install(
				appBundleFromMemory({
					id: previewId,
					name: draft.manifest.name,
					app: draft.app,
					gui: draft.gui
				})
			)
			previews.set(previewId, draft.manifest.name)
			return { kind: 'url', src: `/_preview/${encodeURIComponent(previewId)}/` }
		},
		stop: async ({ previewId }) => {
			previews.delete(previewId)
			await kernel.uninstall(previewId).catch(() => {})
			workers.drop(previewId)
		}
	}
	return {
		sandbox: workers.get,
		capability: (hostKernel) => {
			kernel = hostKernel
			return devkitCapability({
				fs,
				kernel,
				compile: async (input, runtime, resolved) =>
					esbuildCompile(input, (await import('esbuild')).build, runtime, resolved),
				typecheck: async (input, types, paths, resolved) =>
					tsTypecheckImports(input, await import('typescript'), types, paths, resolved),
				imports,
				runner,
				overwrite: true
			})
		},
		handle: async (req, res, path) => {
			const route = previewRoute(path)
			if (!route) return false
			const title = previews.get(route.appId)
			if (!title) return reply(res, 404, 'preview not found')
			if (route.path === '/') {
				res.setHeader('content-type', 'text/html; charset=utf-8')
				res.end(previewPage(title))
				return true
			}
			if (await kernelEndpoint(req, res, route.path, kernel, route.appId)) return true
			if (route.path !== '/gui.js') return reply(res, 404, 'preview asset not found')
			const data = await (await kernel.app(route.appId)).read('gui.js').catch(() => null)
			if (!data) return reply(res, 404, 'preview asset not found')
			res.setHeader('content-type', 'application/javascript; charset=utf-8')
			res.end(Buffer.from(data))
			return true
		},
		close: workers.close
	}
}

export async function kernelEndpoint(
	req: IncomingMessage,
	res: ServerResponse,
	path: string,
	kernel: Kernel,
	appId: string
): Promise<boolean> {
	if (path === '/_state') {
		res.setHeader('content-type', 'application/json')
		res.end(JSON.stringify(await kernel.state(appId)))
		return true
	}
	if (path === '/_subscribe') {
		res.setHeader('content-type', 'text/event-stream')
		res.setHeader('cache-control', 'no-cache')
		res.setHeader('connection', 'keep-alive')
		const send = (state: unknown) => res.write(`data: ${JSON.stringify(state)}\n\n`)
		const initial = await kernel.state(appId)
		if (initial !== undefined) send(initial)
		const off = kernel.subscribe((event) => {
			if (event.type === 'app.update' && event.appId === appId) send(event.state)
		})
		req.on('close', off)
		return true
	}
	if (path !== '/_dispatch' || req.method !== 'POST') return false
	try {
		const result = await kernel.dispatch(appId, (await readJson(req)) as Message)
		res.setHeader('content-type', 'application/json')
		res.end(JSON.stringify(result ?? null))
	} catch (error) {
		res.statusCode = 400
		res.end(error instanceof Error ? error.message : String(error))
	}
	return true
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	let body = ''
	for await (const chunk of req) body += chunk
	return body ? JSON.parse(body) : {}
}

function workerPool(): {
	get: GetSandbox
	drop(appId: string): void
	close(): void
} {
	const cells = new Map<string, Cell>()
	const drop = (appId: string, error = new Error('sandbox worker stopped')) => {
		const cell = cells.get(appId)
		if (!cell) return
		cells.delete(appId)
		cell.stop(error)
	}
	return {
		get: async ({ appId, code }) => {
			let cell = cells.get(appId)
			if (cell?.code !== code) {
				drop(appId, new Error('sandbox worker replaced'))
				cell = spawn(code, () => cells.delete(appId))
				cells.set(appId, cell)
			}
			return cell.sandbox
		},
		drop,
		close: () => {
			for (const appId of [...cells.keys()]) drop(appId)
		}
	}
}

function spawn(code: string, onDead: () => void): Cell {
	const dataUrl = (source: string) =>
		`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
	const worker = new Worker(new URL(dataUrl(sandboxWorkerSource(dataUrl(code), 'node'))))
	const { sandbox, fail } = sandboxClient({
		post: (message) => worker.postMessage(message),
		onMessage: (handler) => worker.on('message', handler)
	})
	let stopped = false
	const stop = (error: Error) => {
		if (stopped) return
		stopped = true
		fail(error)
		void worker.terminate()
	}
	worker.on('error', (error) => {
		if (stopped) return
		onDead()
		stop(error instanceof Error ? error : new Error(String(error)))
	})
	worker.on('exit', (code) => {
		if (stopped) return
		onDead()
		stop(new Error(`sandbox worker exited: ${code}`))
	})
	return { code, sandbox, stop }
}

function previewRoute(path: string): { appId: string; path: string } | undefined {
	if (!path.startsWith('/_preview/')) return undefined
	const rest = path.slice('/_preview/'.length)
	const slash = rest.indexOf('/')
	if (slash < 0) return undefined
	try {
		return { appId: decodeURIComponent(rest.slice(0, slash)), path: rest.slice(slash) }
	} catch {
		return undefined
	}
}

function reply(res: ServerResponse, status: number, body: string): true {
	res.statusCode = status
	res.end(body)
	return true
}

const escapeHtml = (text: string) =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

function previewPage(title: string): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>${escapeHtml(title)}</title>
		<script type="module" src="/_kernel-host/dev-style.js"></script>
	</head>
	<body>
		<div id="app"></div>
		<script type="module">
			import { gui } from './gui.js'
			const root = document.getElementById('app')
			const state = await fetch('./_state').then((response) => response.json())
			const transport = {
				invoke: (message) => fetch('./_dispatch', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(message)
				}).then(async (response) => {
					if (!response.ok) throw new Error(await response.text())
					return response.json()
				}),
				subscribe: (onState) => {
					const events = new EventSource('./_subscribe')
					events.onmessage = (event) => onState(JSON.parse(event.data))
					return () => events.close()
				}
			}
			gui.mount(root, state, { transport })
		</script>
	</body>
</html>`
}

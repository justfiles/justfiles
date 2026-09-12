import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@earendil-works/pi-ai'
import { createServer, type ViteDevServer } from 'vite'
import { afterEach, expect, test, vi } from 'vitest'
import type { AiBackend, GenerateText } from './capabilities/ai/dev.ts'
import { devAi, kernelHost } from './vite.ts'

const roots: string[] = []
const servers = new Set<ViteDevServer>()

afterEach(async () => {
	for (const server of servers) await server.close()
	servers.clear()
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

async function project() {
	const root = await mkdtemp(join(tmpdir(), 'app-dev-storage-'))
	roots.push(root)
	await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app-test', type: 'module' }))
	await mkdir(join(root, 'src'))
	await writeFile(join(root, 'src/gui.ts'), 'export const gui = {}')
	await writeFile(
		join(root, 'src/app.ts'),
		`export const app = {
	initialState: { count: 0 },
	capabilities: { files: { id: 'volume', scopes: ['app'] } },
	actions: { increment: { kind: 'handler' }, write: { kind: 'procedure' }, read: { kind: 'procedure' } },
	dispatch(_message, { state }) {
		const next = { count: (state?.count ?? 0) + 1 }
		return { state: next, result: next }
	},
	async runProcedure(name, params, app) {
		if (name === 'write') {
			await app.invoke('files', 'writeFile', params.path, new TextEncoder().encode(params.text))
			return null
		}
		return new TextDecoder().decode(await app.invoke('files', 'readFile', params.path))
	}
}`
	)
	return root
}

async function start(root: string, deny?: string[], backend?: AiBackend) {
	const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
	const plugins = kernelHost({ id: 'app.test', name: 'Test', app: 'src/app.ts', gui: 'src/gui.ts' })
	cwd.mockRestore()
	const server = await createServer({
		root,
		configFile: false,
		plugins: [...plugins, ...(backend ? [devAi(backend)] : [])],
		resolve: {
			alias: {
				'@justfiles/app/dev-server': fileURLToPath(new URL('./dev-server.ts', import.meta.url))
			}
		},
		logLevel: 'silent',
		server: { host: '127.0.0.1', port: 0, fs: { deny } },
		optimizeDeps: { noDiscovery: true, include: [] }
	})
	servers.add(server)
	await server.listen()
	const address = server.httpServer?.address()
	if (!address || typeof address === 'string') throw new Error('missing dev server address')
	const base = `http://127.0.0.1:${address.port}`
	expect((await fetch(`${base}/_state`)).status).toBe(200)
	return {
		get(path: string) {
			return fetch(`${base}${path}`)
		},
		async gui() {
			return fetch(`${base}/_kernel-host/gui`).then((response) => response.json()) as Promise<{
				version: number
				code?: string
				error?: string
			}>
		},
		async state() {
			return fetch(`${base}/_state`).then((response) => response.json())
		},
		async dispatch(type: string, params: Record<string, unknown> = {}) {
			const response = await fetch(`${base}/_dispatch`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ type, params })
			})
			if (!response.ok) throw new Error(await response.text())
			return response.json()
		},
		async close() {
			await server.close()
			servers.delete(server)
		}
	}
}

test('dev files and reducer state survive restarting the server', async () => {
	const root = await project()
	const first = await start(root)
	await first.dispatch('increment')
	await first.dispatch('write', { path: '/note.md', text: 'Saved note' })
	await first.close()

	const diskPath = join(root, '.justfiles/dev/data/app.test/note.md')
	expect(await readFile(diskPath, 'utf8')).toBe('Saved note')
	await writeFile(diskPath, 'Edited outside the app')

	const reopened = await start(root)
	expect(await reopened.state()).toEqual({ count: 1 })
	expect(await reopened.dispatch('read', { path: '/note.md' })).toBe('Edited outside the app')
	await writeFile(diskPath, 'Edited while running')
	await expect
		.poll(() => reopened.dispatch('read', { path: '/note.md' }), { timeout: 10_000 })
		.toBe('Edited while running')
}, 30_000)

test('projects with the same app id have separate storage', async () => {
	const firstRoot = await project()
	const secondRoot = await project()
	const first = await start(firstRoot)
	const second = await start(secondRoot)
	await first.dispatch('increment')
	await first.dispatch('write', { path: '/note.md', text: 'First project' })
	await second.dispatch('write', { path: '/note.md', text: 'Second project' })
	expect(await second.dispatch('increment')).toEqual({ count: 1 })
	expect(await first.dispatch('read', { path: '/note.md' })).toBe('First project')
	expect(await second.dispatch('read', { path: '/note.md' })).toBe('Second project')
}, 30_000)

test('persisted data is not served as static files or raw modules', async () => {
	const root = await project()
	await mkdir(join(root, 'public'))
	await writeFile(join(root, 'public/hello.txt'), 'Public asset')
	await writeFile(join(root, '.env.private'), 'PRIVATE_VALUE=hidden')
	await writeFile(join(root, 'private.txt'), 'Custom deny')
	const server = await start(root, ['**/private.txt'])
	await server.dispatch('increment')
	await server.dispatch('write', { path: '/note.md', text: 'Private note' })

	for (const path of [
		'.justfiles/dev/data/app.test/note.md',
		'.justfiles/dev/state/app.test.json',
		'.justfiles/dev/.jfs/index.json',
		'.env.private',
		'private.txt'
	]) {
		for (const url of [`/${path}`, `/@fs/${join(root, path)}`, `/${path}?raw`]) {
			const response = await server.get(url)
			expect(response.status, url).toBe(403)
		}
	}
	expect(await server.dispatch('read', { path: '/note.md' })).toBe('Private note')
	expect(await server.state()).toEqual({ count: 1 })
	expect(await server.get('/hello.txt').then((response) => response.text())).toBe('Public asset')
	expect((await server.get('/src/gui.ts')).status).toBe(200)
}, 30_000)

test('GUI builds embed assets and CSS, recover from errors, and ignore data writes', async () => {
	vi.stubEnv('NODE_ENV', 'development')
	const root = await project()
	const entry = join(root, 'src/gui.ts')
	await writeFile(join(root, 'src/style.css'), 'h1 { color: #123456 }')
	await writeFile(join(root, 'src/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
	const source = `import './style.css'; import icon from './icon.svg'; export const gui = { icon, marker: 'first', production: import.meta.env.PROD }`
	await writeFile(entry, source)
	const host = await start(root)
	await expect.poll(() => host.gui().then((bundle) => bundle.code)).toContain('first')
	const first = await host.gui()
	expect(process.env.NODE_ENV).toBe('development')
	const { gui } = await import(`data:text/javascript,${encodeURIComponent(first.code!)}`)
	expect(gui.production).toBe(true)
	expect(first.code).toContain('data:image/svg+xml')
	expect(first.code).toContain('data-app-style')
	expect(first.code).toContain('#123456')
	await host.dispatch('increment')
	await host.dispatch('write', { path: '/note.md', text: 'no rebuild' })
	await writeFile(entry, 'export const gui = { broken: ')
	await expect.poll(() => host.gui().then((bundle) => bundle.error)).toBeTruthy()
	expect((await host.gui()).version).toBe(first.version + 1)
	await writeFile(entry, source.replace('first', 'recovered'))
	await expect.poll(() => host.gui().then((bundle) => bundle.code)).toContain('recovered')
	expect((await host.gui()).error).toBeUndefined()
	expect(await host.state()).toEqual({ count: 1 })
	await expect(readFile(join(root, 'dist/gui.js'))).rejects.toMatchObject({ code: 'ENOENT' })
	await host.close()
	// Closing the server must also close the build watcher before this directory is removed.
	await rm(root, { recursive: true, force: true })
}, 30_000)

async function agentProject() {
	const root = await project()
	const entry = join(root, 'src/app.ts')
	let source = await readFile(entry, 'utf8')
	source = source.replace(
		'capabilities: { files:',
		"capabilities: { model: { id: 'ai', scopes: ['agent'] }, files:"
	)
	source = source.replace(
		'actions: { increment:',
		"actions: { work: { kind: 'procedure' }, stop: { kind: 'procedure' }, increment:"
	)
	source = source.replace(
		"if (name === 'write')",
		"if (name === 'work') return app.invoke('model', 'runAgent', params); if (name === 'stop') return app.invoke('model', 'cancelAgent', params); if (name === 'write')"
	)
	await writeFile(entry, source)
	return root
}

function agentText(run: (context: Context, signal: AbortSignal) => Promise<unknown>): GenerateText {
	return Object.assign(async () => 'text', {
		agent: async ({ prompt, signal }) => {
			const context = JSON.parse(prompt)
			const last = context.messages.at(-1)
			if (context.tools[0]?.name === 'lookupFixture')
				return JSON.stringify(
					last.role === 'toolResult'
						? { type: 'final', text: last.content[0].text }
						: { type: 'tool_call', name: 'lookupFixture', arguments: {} }
				)
			return JSON.stringify(await run(context, signal))
		}
	})
}

test('dev agent writes through app capabilities, stays responsive, stops and reopens without replay', async () => {
	const root = await agentProject()
	const started = Promise.withResolvers<void>()
	let turns = 0
	const backend = agentText(async (context, signal) => {
		turns++
		if (
			(typeof context.messages[0].content === 'string'
				? context.messages[0].content
				: context.messages[0].content[0].text) === 'wait'
		) {
			started.resolve()
			await new Promise((_, reject) =>
				signal.addEventListener('abort', () => reject(signal.reason), { once: true })
			)
		}
		return context.messages.at(-1).role === 'toolResult'
			? { type: 'final', text: 'saved' }
			: {
					type: 'tool_call',
					name: 'capability',
					arguments: {
						capability: 'files',
						method: 'writeFile',
						args: ['/agent.md', { $bytes: 'Agent wrote this' }]
					}
				}
	})
	const first = await start(root, undefined, backend)
	expect(await first.dispatch('work', { requestId: 'write', prompt: 'write' })).toEqual({
		text: 'saved'
	})
	expect(await first.dispatch('read', { path: '/agent.md' })).toBe('Agent wrote this')
	const running = first.dispatch('work', { requestId: 'wait', prompt: 'wait' })
	await started.promise
	expect(await first.dispatch('increment')).toEqual({ count: 1 })
	expect(await first.dispatch('stop', { requestId: 'stale' })).toBe(false)
	expect(await first.dispatch('stop', { requestId: 'wait' })).toBe(true)
	expect(await running).toEqual({ cancelled: true })
	await first.close()
	const before = turns
	const second = await start(root, undefined, backend)
	expect(await second.dispatch('read', { path: '/agent.md' })).toBe('Agent wrote this')
	expect(await second.dispatch('stop', { requestId: 'wait' })).toBe(false)
	expect(turns).toBe(before)
}, 30_000)

test.each([
	'reload',
	'dependency',
	'close'
])('headless %s aborts active agent work and drains before replacing context', async (action) => {
	const root = await agentProject()
	if (action === 'dependency') {
		await writeFile(join(root, 'src/settings.ts'), 'export const initial = 0')
		const entry = join(root, 'src/app.ts')
		await writeFile(
			entry,
			`import { initial } from './settings.ts';\n${(await readFile(entry, 'utf8')).replace('count: 0', 'count: initial')}`
		)
	}
	const started = Promise.withResolvers<void>()
	const stopped = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	let waits = true
	const backend = agentText(async (_, signal) => {
		if (waits) {
			started.resolve()
			signal.addEventListener('abort', () => stopped.resolve(), { once: true })
			await release.promise
		}
		return { type: 'final', text: 'ready' }
	})
	const host = await start(root, undefined, backend)
	const running = host
		.dispatch('work', { requestId: 'one', prompt: 'wait' })
		.catch((error) => ({ error }))
	await started.promise
	let closing: Promise<void> | undefined
	if (action === 'dependency') {
		await writeFile(join(root, 'src/settings.ts'), 'export const initial = 10')
	} else if (action === 'reload') {
		const entry = join(root, 'src/app.ts')
		await writeFile(entry, (await readFile(entry, 'utf8')).replace('count: 0', 'count: 10'))
	} else closing = host.close()
	try {
		await stopped.promise
		let settled = false
		void (closing ?? running).then(() => {
			settled = true
		})
		await new Promise((done) => setTimeout(done, 20))
		expect(settled).toBe(false)
	} finally {
		waits = false
		release.resolve()
	}
	if (action !== 'close') expect(await running).toEqual({ cancelled: true })
	else await running
	await closing
	if (action !== 'close')
		await expect
			.poll(() => host.dispatch('work', { requestId: 'two', prompt: 'go' }))
			.toEqual({ text: 'ready' })
}, 30_000)

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'
import { afterEach, expect, test, vi } from 'vitest'
import { kernelHost } from './vite.ts'

const roots: string[] = []
const servers = new Set<ViteDevServer>()

afterEach(async () => {
	for (const server of servers) await server.close()
	servers.clear()
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function project() {
	const root = await mkdtemp(join(tmpdir(), 'app-dev-storage-'))
	roots.push(root)
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

async function start(root: string) {
	const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
	const plugins = kernelHost({ id: 'app.test', name: 'Test', app: 'src/app.ts', gui: 'src/gui.ts' })
	cwd.mockRestore()
	const server = await createServer({
		root,
		configFile: false,
		plugins,
		resolve: {
			alias: {
				'@justfiles/app/dev-server': fileURLToPath(new URL('./dev-server.ts', import.meta.url))
			}
		},
		logLevel: 'silent',
		server: { host: '127.0.0.1', port: 0 },
		optimizeDeps: { noDiscovery: true, include: [] }
	})
	servers.add(server)
	await server.listen()
	const address = server.httpServer?.address()
	if (!address || typeof address === 'string') throw new Error('missing dev server address')
	const base = `http://127.0.0.1:${address.port}`
	expect((await fetch(`${base}/_state`)).status).toBe(200)
	return {
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

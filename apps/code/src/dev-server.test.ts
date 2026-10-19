import { cp, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { afterEach, expect, test, vi } from 'vitest'

let server: ViteDevServer | undefined
let root: string | undefined

afterEach(async () => {
	await server?.close()
	server = undefined
	if (root) await rm(root, { recursive: true, force: true })
	root = undefined
})

// The dev server persists drafts under `<root>/.justfiles/dev`, and `kernelHost` resolves
// entries from the cwd. A copy in a temp root keeps the run fresh and off a real store.
async function appCopy(): Promise<string> {
	const app = resolve(import.meta.dirname, '..')
	const dir = await mkdtemp(join(tmpdir(), 'app-code-dev-'))
	for (const file of ['package.json', 'tsconfig.json', 'vite.config.ts', 'devkit-sysroot.ts'])
		await cp(join(app, file), join(dir, file))
	for (const folder of ['src', 'public'])
		await cp(join(app, folder), join(dir, folder), { recursive: true })
	await symlink(join(app, 'node_modules'), join(dir, 'node_modules'))
	return dir
}

// Starting the server builds the whole devkit sysroot (SDK runtime + rolled-up types), like
// the other `buildRuntime` tests — so it gets their 60s budget.
test('local development can run, stop, and install a draft', async () => {
	const template = process.env.DEVKIT_REACT_E2E === '1' ? 'react' : 'plain'
	root = await appCopy()
	vi.spyOn(process, 'cwd').mockReturnValue(root)
	server = await createServer({
		root,
		logLevel: 'silent',
		server: { host: '127.0.0.1', port: 0, strictPort: true }
	})
	vi.restoreAllMocks()
	await server.listen()
	const address = server.httpServer?.address()
	if (!address || typeof address === 'string') throw new Error('Vite did not open a TCP port')
	const origin = `http://127.0.0.1:${address.port}`
	let ready = false
	for (let attempt = 0; !ready && attempt < 100; attempt++) {
		ready = (await fetch(`${origin}/_state`)).ok
		if (!ready) await new Promise((resolve) => setTimeout(resolve, 10))
	}
	expect(ready).toBe(true)
	const invoke = async <T>(type: string, params: object): Promise<T> => {
		const response = await fetch(`${origin}/_dispatch`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ type, params })
		})
		if (!response.ok) throw new Error(await response.text())
		return response.json() as Promise<T>
	}

	await invoke('create', { name: 'Local Counter', id: 'local.counter', template })
	await invoke('open', { slug: 'local.counter' })
	expect(await invoke('typecheck', {})).toEqual({ diagnostics: [] })
	const result = await invoke<{
		preview?: { kind: string; src: string }
	}>('run', {})
	expect(result.preview).toMatchObject({ kind: 'url' })

	const preview = new URL(result.preview!.src, origin)
	expect((await fetch(preview)).ok).toBe(true)
	expect(await fetch(new URL('_state', preview)).then((response) => response.json())).toEqual({
		count: 0
	})
	const dispatch = await fetch(new URL('_dispatch', preview), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ type: 'increment', params: { amount: 2 } })
	})
	expect(dispatch.ok).toBe(true)
	expect(await fetch(new URL('_state', preview)).then((response) => response.json())).toEqual({
		count: 2
	})
	await invoke('run', { reset: true })
	expect(await fetch(new URL('_state', preview)).then((response) => response.json())).toEqual({
		count: 0
	})

	await invoke('stop', {})
	expect((await fetch(preview)).status).toBe(404)
	expect(await invoke('install', {})).toEqual({ id: 'local.counter' })
}, 60_000)

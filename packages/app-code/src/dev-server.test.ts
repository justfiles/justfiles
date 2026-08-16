import { resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { afterEach, expect, test } from 'vitest'

let server: ViteDevServer | undefined

afterEach(async () => {
	await server?.close()
	server = undefined
})

test('local development can run, stop, and install a draft', async () => {
	server = await createServer({
		root: resolve(import.meta.dirname, '..'),
		logLevel: 'silent',
		server: { host: '127.0.0.1', port: 0, strictPort: true }
	})
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

	await invoke('create', { name: 'Local Counter', id: 'local.counter' })
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
}, 30_000)

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedConfig } from 'vite'
import { expect, test, vi } from 'vitest'
import { localStore } from './vite.local-store.ts'

test('a watch build serves a Runner store and its app files', async () => {
	const root = mkdtempSync(join(tmpdir(), 'local-app-store-'))
	const dist = join(root, 'dist')
	mkdirSync(join(dist, 'assets'), { recursive: true })
	writeFileSync(join(dist, 'app.js'), 'APP')
	writeFileSync(join(dist, 'gui.js'), 'GUI')
	writeFileSync(join(dist, 'icon.svg'), '<svg/>')
	writeFileSync(join(dist, 'assets/value.txt'), 'VALUE')
	writeFileSync(
		join(dist, 'manifest.json'),
		JSON.stringify({
			id: 'app.test',
			name: 'Test',
			version: '1.2.3',
			icon: 'icon.svg',
			app: 'app.js',
			gui: 'gui.js',
			include: ['assets/**']
		})
	)

	const info = vi.fn()
	const plugin = localStore(0)
	const resolveConfig = plugin.configResolved as (config: ResolvedConfig) => void
	resolveConfig({
		root,
		build: { outDir: 'dist', watch: {} },
		logger: { info }
	} as unknown as ResolvedConfig)
	const close = plugin.closeBundle as { handler: () => Promise<void> }

	try {
		await close.handler()
		const message = String(info.mock.calls[0]?.[0])
		const storeUrl = message.match(/http:\/\/localhost:\d+\/store\.json/)?.[0]
		expect(storeUrl).toBeDefined()
		const storeResponse = await fetch(storeUrl!)
		const store = await storeResponse.json()
		expect(storeResponse.headers.get('access-control-allow-origin')).toBe('*')
		expect(store).toMatchObject({
			schema: 'justapps/store/v1',
			apps: [{ id: 'app.test', version: '1.2.3' }]
		})

		const manifestResponse = await fetch(store.apps[0].manifestUrl)
		const manifest = await manifestResponse.json()
		expect(manifest.schema).toBe('justapps/manifest/v1')
		expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([
			'app.js',
			'assets/value.txt',
			'gui.js',
			'icon.svg'
		])
		const appResponse = await fetch(new URL('app.js', store.apps[0].manifestUrl))
		const bytes = new Uint8Array(await appResponse.arrayBuffer())
		expect(manifest.files[0].hash).toBe(
			`sha256-${createHash('sha256').update(bytes).digest('hex')}`
		)
		expect(new TextDecoder().decode(bytes)).toBe('APP')
		const cached = await fetch(store.apps[0].manifestUrl, {
			headers: { 'If-None-Match': manifestResponse.headers.get('etag')! }
		})
		expect(cached.status).toBe(304)

		writeFileSync(join(dist, 'app.js'), 'NEXT')
		await close.handler()
		const nextResponse = await fetch(store.apps[0].manifestUrl, {
			headers: { 'If-None-Match': manifestResponse.headers.get('etag')! }
		})
		const next = await nextResponse.json()
		expect(nextResponse.status).toBe(200)
		expect(next.hash).not.toBe(manifest.hash)
		expect(
			await fetch(new URL('app.js', store.apps[0].manifestUrl)).then((res) => res.text())
		).toBe('NEXT')
	} finally {
		await (plugin.closeWatcher as () => Promise<void>)()
		rmSync(root, { recursive: true, force: true })
	}
})

test('a normal build does not start the local store', async () => {
	const info = vi.fn()
	const plugin = localStore(0)
	const resolveConfig = plugin.configResolved as (config: ResolvedConfig) => void
	resolveConfig({
		root: '/unused',
		build: { outDir: 'dist', watch: null },
		logger: { info }
	} as unknown as ResolvedConfig)
	const close = plugin.closeBundle as { handler: () => Promise<void> }

	await close.handler()
	expect(info).not.toHaveBeenCalled()
})

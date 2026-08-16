import { createHash } from 'node:crypto'
import { type AppStore, type CatalogApp, installApp } from '@justfiles/app/appstore'
import { appBundleFromMemory, kernel } from '@justfiles/app/runtime'
import { memStorage, volume } from '@justfiles/fs'
import { expect, test } from 'vitest'
import { appAssets } from './app-assets'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const text = (value: Uint8Array): string => new TextDecoder().decode(value)
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

async function hostedWorld() {
	const fs = volume(memStorage())
	const baseUrl = 'https://notes.justapps.run/v/1/'
	const payload = { 'app.js': 'REDUCER', 'gui.js': 'GUI', 'icon.png': 'ICON' }
	let online = true
	let requests = 0
	const assets = await appAssets(fs, async (url) => {
		requests++
		if (!online) throw new Error('offline')
		const body = payload[url.slice(baseUrl.length) as keyof typeof payload]
		return body === undefined ? new Response(null, { status: 404 }) : new Response(bytes(body))
	})
	const app: CatalogApp = {
		id: 'justfiles.notes',
		name: 'Notes',
		version: '1.0.0',
		baseUrl,
		manifest: {
			id: 'justfiles.notes',
			name: 'Notes',
			version: '1.0.0',
			app: 'app.js',
			gui: 'gui.js',
			icon: 'icon.png'
		},
		files: Object.entries(payload).map(([path, body]) => ({
			path,
			hash: `sha256-${digest(body)}`,
			size: bytes(body).byteLength
		}))
	}
	const store: AppStore = {
		async builtins() {
			return [app]
		},
		async latest() {
			return app
		},
		async read(_app, path) {
			return bytes(payload[path as keyof typeof payload])
		}
	}
	const appKernel = kernel({
		fs,
		fetchAsset: assets,
		sandbox: async () => {
			throw new Error('not used')
		},
		clock: {}
	})
	await installApp(appKernel, store, app)
	return {
		fs,
		app,
		appKernel,
		baseUrl,
		requests: () => requests,
		goOffline: () => {
			online = false
		}
	}
}

test('a hosted install keeps only its record and reducer, then runs offline', async () => {
	const world = await hostedWorld()

	expect((await world.fs.readdir('/applications/justfiles.notes')).map(({ name }) => name)).toEqual(
		['app.js', 'manifest.json']
	)
	expect(await world.fs.exists('/applications/justfiles.notes/gui.js')).toBe(false)
	expect(await world.fs.exists('/applications/justfiles.notes/icon.png')).toBe(false)
	expect(await world.fs.readdir('/private/cache/apps')).toHaveLength(2)

	world.goOffline()
	const installed = await world.appKernel.app(world.app.id)
	expect(text(await installed.read('gui.js'))).toBe('GUI')
	expect(text(await installed.read('icon.png'))).toBe('ICON')
})

test('a bad cached asset is rejected, evicted, and fetched again', async () => {
	const world = await hostedWorld()
	const installed = await world.appKernel.app(world.app.id)
	const guiUrl = `${world.baseUrl}gui.js`
	const guiCache = `/private/cache/apps/${digest(guiUrl)}`
	await world.fs.writeFile(guiCache, bytes('BAD'))
	const requestsBeforeRead = world.requests()

	await expect(installed.read('gui.js')).rejects.toThrow('hash mismatch')
	expect(text(await installed.read('gui.js'))).toBe('GUI')
	expect(world.requests()).toBe(requestsBeforeRead + 1)
})

test('a local install keeps its complete bundle in the Volume', async () => {
	const fs = volume(memStorage())
	let requests = 0
	const appKernel = kernel({
		fs,
		fetchAsset: await appAssets(fs, async () => {
			requests++
			return new Response()
		}),
		sandbox: async () => {
			throw new Error('not used')
		},
		clock: {}
	})

	await appKernel.install(
		appBundleFromMemory({
			id: 'local.code',
			name: 'Local',
			app: 'REDUCER',
			gui: 'GUI',
			icon: 'icon.png',
			assets: { 'icon.png': 'ICON' }
		})
	)

	expect(new Set((await fs.readdir('/applications/local.code')).map(({ name }) => name))).toEqual(
		new Set(['app.js', 'cli.js', 'gui.js', 'icon.png', 'manifest.json'])
	)
	expect(text(await (await appKernel.app('local.code')).read('gui.js'))).toBe('GUI')
	expect(requests).toBe(0)
})

import { expect, test } from 'bun:test'
import { loadApp } from './app-loader.js'
import type { App, Host, Manifest } from './contract.js'
import { defineApp } from './contract.js'

const manifest: Manifest = {
	id: 'hello',
	title: 'Hello',
	version: '0.1.0',
	entry: 'index.js'
}

const host: Host = {
	version: 1,
	volume: {
		async readText() {
			return ''
		},
		async writeText() {},
		async readFile() {
			return new Uint8Array()
		},
		async writeFile() {}
	}
}
const el = {} as HTMLElement

test('loadApp mounts the default export with the supplied el and host', async () => {
	let received: { el: HTMLElement; host: Host } | undefined
	const app = defineApp({
		id: 'hello',
		mount(mountEl, mountHost) {
			received = { el: mountEl, host: mountHost }
		},
		unmount() {}
	})
	const handle = await loadApp({
		manifest,
		baseUrl: 'http://x/apps/hello/',
		el,
		host,
		importer: async () => ({ default: app })
	})
	expect(received?.el).toBe(el)
	expect(received?.host).toBe(host)
	expect(handle.id).toBe('hello')
})

test('loadApp resolves manifest.entry against baseUrl', async () => {
	let receivedUrl = ''
	await loadApp({
		manifest,
		baseUrl: 'http://x/apps/hello/',
		el,
		host,
		importer: async (url) => {
			receivedUrl = url
			return { default: defineApp({ id: 'hello', mount: () => {}, unmount: () => {} }) }
		}
	})
	expect(receivedUrl).toBe('http://x/apps/hello/index.js')
})

test('unmount() calls the app exactly once', async () => {
	let count = 0
	const handle = await loadApp({
		manifest,
		baseUrl: 'http://x/apps/hello/',
		el,
		host,
		importer: async () => ({
			default: defineApp({
				id: 'hello',
				mount: () => {},
				unmount() {
					count++
				}
			})
		})
	})
	await handle.unmount()
	await handle.unmount()
	expect(count).toBe(1)
})

test('loadApp reports fetch failure with the entry URL', async () => {
	await expect(
		loadApp({
			manifest,
			baseUrl: 'http://x/apps/hello/',
			el,
			host,
			importer: async () => {
				throw new Error('network down')
			}
		})
	).rejects.toThrow(/app entry fetch failed.*hello\/index\.js.*network down/)
})

test('loadApp rejects a missing default export', async () => {
	await expect(
		loadApp({
			manifest,
			baseUrl: 'http://x/apps/hello/',
			el,
			host,
			importer: async () => ({})
		})
	).rejects.toThrow(/missing a default export/)
})

test('loadApp rejects a default export missing mount()', async () => {
	await expect(
		loadApp({
			manifest,
			baseUrl: 'http://x/apps/hello/',
			el,
			host,
			importer: async () => ({ default: { id: 'hello', unmount: () => {} } as Partial<App> })
		})
	).rejects.toThrow(/missing `mount\(\)`/)
})

test('loadApp rejects a default export missing unmount()', async () => {
	await expect(
		loadApp({
			manifest,
			baseUrl: 'http://x/apps/hello/',
			el,
			host,
			importer: async () => ({ default: { id: 'hello', mount: () => {} } as Partial<App> })
		})
	).rejects.toThrow(/missing `unmount\(\)`/)
})

test('loadApp rejects a default export missing id', async () => {
	await expect(
		loadApp({
			manifest,
			baseUrl: 'http://x/apps/hello/',
			el,
			host,
			importer: async () => ({ default: { mount: () => {}, unmount: () => {} } as Partial<App> })
		})
	).rejects.toThrow(/missing a string `id`/)
})

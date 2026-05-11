import { expect, test } from 'bun:test'
import { isNewManifest, loadManifest } from './manifest-loader.js'

const validManifest = {
	id: 'hello',
	title: 'Hello',
	version: '0.1.0',
	entry: 'index.js'
}

const jsonResponse = (body: unknown, init?: ResponseInit) =>
	new Response(JSON.stringify(body), { status: 200, ...init })

test('loadManifest returns a validated manifest', async () => {
	const fetcher = (async () => jsonResponse(validManifest)) as unknown as typeof fetch
	const manifest = await loadManifest({ url: 'http://x/manifest.json', fetcher })
	expect(manifest).toEqual(validManifest)
})

test('loadManifest rejects non-OK responses', async () => {
	const fetcher = (async () =>
		new Response('not found', { status: 404 })) as unknown as typeof fetch
	await expect(loadManifest({ url: 'http://x/manifest.json', fetcher })).rejects.toThrow(/HTTP 404/)
})

test('loadManifest rejects malformed JSON', async () => {
	const fetcher = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch
	await expect(loadManifest({ url: 'http://x/manifest.json', fetcher })).rejects.toThrow(
		/not valid JSON/
	)
})

test('loadManifest rejects manifests that fail schema validation', async () => {
	const fetcher = (async () =>
		jsonResponse({ id: 'hello', entry: 'index.js' })) as unknown as typeof fetch
	await expect(loadManifest({ url: 'http://x/manifest.json', fetcher })).rejects.toThrow(/invalid/)
})

test('loadManifest rejects network failures', async () => {
	const fetcher = (async () => {
		throw new Error('boom')
	}) as unknown as typeof fetch
	await expect(loadManifest({ url: 'http://x/manifest.json', fetcher })).rejects.toThrow(
		/manifest fetch failed/
	)
})

test('isNewManifest discriminates between new and legacy shapes', () => {
	expect(isNewManifest(validManifest)).toBe(true)
	expect(isNewManifest({ format: 1, name: 'Hello', entry: 'index.html', permissions: [] })).toBe(
		false
	)
	expect(isNewManifest(null)).toBe(false)
	expect(isNewManifest({})).toBe(false)
})

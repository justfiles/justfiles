import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReleaseManifest, StoreIndex } from '@justfiles/app/appstore/protocol'
import { afterEach, expect, test } from 'vitest'
import { type DevStore, startDevStore } from './dev-store.ts'

const dirs: string[] = []
let store: DevStore | undefined

afterEach(async () => {
	await store?.close()
	store = undefined
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test('serves and refreshes built apps', async () => {
	const first = await app('app.first', 'FIRST')
	const second = await app('app.second', 'SECOND')
	store = await startDevStore([first, second], 0)

	const index = await json<StoreIndex>(store.url)
	expect(index.apps.map((entry: { id: string }) => entry.id)).toEqual(['app.first', 'app.second'])

	const manifestUrl = index.apps[0].manifestUrl as string
	const before = await json<ReleaseManifest>(manifestUrl)
	expect(await fetch(new URL('app.js', manifestUrl)).then((response) => response.text())).toBe(
		'FIRST'
	)

	await writeFile(join(first, 'app.js'), 'UPDATED')
	const manifest = join(first, 'manifest.json')
	const future = new Date(Date.now() + 1_000)
	await utimes(manifest, future, future)
	await fetch(store.url)
	const after = await json<ReleaseManifest>(manifestUrl)

	expect(after.hash).not.toBe(before.hash)
	expect(await fetch(new URL('app.js', manifestUrl)).then((response) => response.text())).toBe(
		'UPDATED'
	)
})

async function json<T>(url: string): Promise<T> {
	return fetch(url).then((response) => response.json() as Promise<T>)
}

async function app(id: string, code: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'dev-app-store-'))
	dirs.push(root)
	await mkdir(root, { recursive: true })
	await writeFile(join(root, 'app.js'), code)
	await writeFile(join(root, 'gui.js'), 'GUI')
	await writeFile(join(root, 'icon.svg'), '<svg/>')
	await writeFile(
		join(root, 'manifest.json'),
		JSON.stringify({
			id,
			name: id,
			version: '1.0.0',
			app: 'app.js',
			gui: 'gui.js',
			icon: 'icon.svg'
		})
	)
	return root
}

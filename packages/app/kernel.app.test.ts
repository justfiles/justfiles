import { memStorage, volume } from '@justfiles/fs'
import { expect, test } from 'vitest'
import { type AppBundle, appBundleFromMemory } from './app.ts'
import { apps } from './kernel.app.ts'

// The app store in isolation — no kernel, no sandbox, just a fs. Covers the
// `/applications/<id>` layout, the install-existence guards, and the rollback
// contract: a failed install must not corrupt the previously installed bundle.

const store = () => apps(volume(memStorage()))
const decode = (b: Uint8Array) => new TextDecoder().decode(b)

test('install lays out the bundle and get/has/list reflect it', async () => {
	const s = store()
	const id = await s.install(
		appBundleFromMemory({ id: 'com.example.app', name: 'App', app: 'CODE_V1' })
	)
	expect(id).toBe('com.example.app')
	expect(await s.has(id)).toBe(true)
	const installed = await s.get(id)
	if (!installed) throw new Error('expected installed')
	expect(installed.manifest.name).toBe('App')
	expect(decode(await installed.read(installed.manifest.app))).toBe('CODE_V1')
	expect((await s.list()).map((m) => m.id)).toEqual(['com.example.app'])
})

test('get is null and has is false for an app that was never installed', async () => {
	const s = store()
	expect(await s.has('com.example.absent')).toBe(false)
	expect(await s.get('com.example.absent')).toBeNull()
	expect(await s.list()).toEqual([])
})

test('an id that is not a safe path segment is rejected', async () => {
	const s = store()
	await expect(s.has('../escape')).rejects.toThrow('invalid app id')
})

test('a failed re-install leaves the previous bundle intact', async () => {
	const s = store()
	await s.install(appBundleFromMemory({ id: 'com.example.app', name: 'App', app: 'CODE_V1' }))

	// A bundle that throws mid-staging — the install must abort and roll back,
	// never having touched the live `/applications/<id>` dir.
	const broken: AppBundle = {
		async manifest() {
			return { id: 'com.example.app', name: 'App v2', app: 'app.js' }
		},
		async *list() {
			yield 'app.js'
		},
		async read() {
			throw new Error('read boom')
		}
	}
	await expect(s.install(broken)).rejects.toThrow('read boom')

	// v1 is still installed and readable; the failed v2 left no trace.
	const installed = await s.get('com.example.app')
	if (!installed) throw new Error('expected v1 still installed')
	expect(installed.manifest.name).toBe('App')
	expect(decode(await installed.read('app.js'))).toBe('CODE_V1')
})

test('uninstall removes the bundle', async () => {
	const s = store()
	const id = await s.install(appBundleFromMemory({ id: 'com.example.app', name: 'App', app: 'X' }))
	await s.uninstall(id)
	expect(await s.has(id)).toBe(false)
	expect(await s.get(id)).toBeNull()
	expect(await s.list()).toEqual([])
})

test('uninstall moves the bundle to /trash atomically instead of deleting it', async () => {
	// The bundle leaves /applications in ONE atomic rename (no torn intermediate
	// state a racing reconcile could "repair"), and its bytes survive under /trash.
	const vol = volume(memStorage())
	const s = apps(vol)
	const id = await s.install(
		appBundleFromMemory({ id: 'com.example.app', name: 'App', app: 'CODE_V1' })
	)
	await s.uninstall(id)

	expect(await s.has(id)).toBe(false)
	expect(await vol.exists(`/applications/${id}`)).toBe(false)

	const trashed = await vol.readdir('/trash')
	expect(trashed).toHaveLength(1)
	const name = trashed[0]?.name ?? ''
	expect(name.startsWith(`${id}-`)).toBe(true)
	const manifest = JSON.parse(decode(await vol.readFile(`/trash/${name}/manifest.json`))) as {
		id: string
	}
	expect(manifest.id).toBe(id)
})

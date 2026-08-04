import { memStorage, volume } from '@justfiles/fs'
import { cachePath } from '@justfiles/fs/sync-replica'
import { expect, test } from 'vitest'
import { type AppBundle, type AppManifest, appBundleFromMemory } from './app.ts'
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

// ── residency (#376): 'cached' splits a bundle across the two lanes ───────────

// A bundle whose assets the store can re-serve. `assets` is what the installer
// states, never what the app declares — `appBundleFromMemory` has no say in it.
function cachedBundle(files: { app: string; gui: string; icon?: Uint8Array }): AppBundle {
	const manifest: AppManifest = {
		id: 'com.example.app',
		name: 'App',
		app: 'app.js',
		gui: 'gui.js',
		icon: files.icon ? 'icon.png' : undefined,
		assets: 'cached'
	}
	const bytes: Record<string, Uint8Array> = {
		'app.js': new TextEncoder().encode(files.app),
		'gui.js': new TextEncoder().encode(files.gui),
		...(files.icon ? { 'icon.png': files.icon } : {})
	}
	return {
		manifest: async () => manifest,
		list: async function* () {
			yield* Object.keys(bytes)
		},
		read: async (path) => bytes[path] ?? new Uint8Array()
	}
}

test('a cached install syncs the reducer and mirrors the rest into /.cache', async () => {
	const vol = volume(memStorage())
	const s = apps(vol)
	const id = await s.install(
		cachedBundle({ app: 'REDUCER', gui: 'GUI', icon: new Uint8Array([1]) })
	)

	// The DO reads these: the installed-app record and the reducer it runs headlessly.
	expect(await vol.exists(`/applications/${id}/manifest.json`)).toBe(true)
	expect(await vol.exists(`/applications/${id}/app.js`)).toBe(true)
	// It never reads these, and the store can re-serve them.
	expect(await vol.exists(`/applications/${id}/gui.js`)).toBe(false)
	expect(await vol.exists(`/applications/${id}/icon.png`)).toBe(false)
	expect(await vol.exists(cachePath(`/applications/${id}/gui.js`))).toBe(true)
	expect(await vol.exists(cachePath(`/applications/${id}/icon.png`))).toBe(true)

	// One `read` surface regardless of lane — the manifest records which is which.
	const installed = await s.get(id)
	if (!installed) throw new Error('expected installed')
	expect(installed.manifest.assets).toBe('cached')
	expect(decode(await installed.read('app.js'))).toBe('REDUCER')
	expect(decode(await installed.read('gui.js'))).toBe('GUI')
})

test('a bundle that states no residency syncs in full', async () => {
	// The devkit path: a locally-authored app has no upstream, so the volume is its
	// only copy and every byte has to replicate.
	const vol = volume(memStorage())
	const s = apps(vol)
	const id = await s.install(
		appBundleFromMemory({ id: 'com.example.app', name: 'App', app: 'CODE', gui: 'GUI' })
	)
	expect((await s.get(id))?.manifest.assets).toBe('synced')
	expect(await vol.exists(`/applications/${id}/gui.js`)).toBe(true)
	expect(await vol.exists(cachePath(`/applications/${id}`))).toBe(false)
})

test('a cached install stages under the mirror, never in the synced tmp dir', async () => {
	// The staging leak the mirror exists to avoid: cached bytes must not be visible to
	// sync even in the window between the write and the commit.
	const vol = volume(memStorage())
	const seen: string[] = []
	const spy = new Proxy(vol, {
		get(target, prop, receiver) {
			if (prop !== 'writeFile') return Reflect.get(target, prop, receiver)
			return async (path: string, data: Uint8Array) => {
				seen.push(path)
				return vol.writeFile(path, data)
			}
		}
	})
	await apps(spy).install(cachedBundle({ app: 'REDUCER', gui: 'GUI' }))
	expect(seen.some((p) => p.endsWith('/gui.js'))).toBe(true)
	for (const path of seen) {
		if (path.endsWith('/gui.js')) expect(path.startsWith('/.cache/')).toBe(true)
	}
})

test('re-installing as synced sweeps the mirror the cached install left', async () => {
	const vol = volume(memStorage())
	const s = apps(vol)
	const id = await s.install(cachedBundle({ app: 'REDUCER', gui: 'GUI' }))
	expect(await vol.exists(cachePath(`/applications/${id}/gui.js`))).toBe(true)

	await s.install(appBundleFromMemory({ id, name: 'App', app: 'REDUCER2', gui: 'GUI2' }))
	expect(decode(await vol.readFile(`/applications/${id}/gui.js`))).toBe('GUI2')
	expect(await vol.exists(cachePath(`/applications/${id}`))).toBe(false)
})

test('a failed cached re-install leaves both lanes on the previous bundle', async () => {
	const vol = volume(memStorage())
	const s = apps(vol)
	const id = await s.install(cachedBundle({ app: 'REDUCER', gui: 'GUI' }))

	const broken: AppBundle = {
		manifest: async () => ({ id, name: 'App v2', app: 'app.js', gui: 'gui.js', assets: 'cached' }),
		list: async function* () {
			yield 'gui.js'
			yield 'app.js'
		},
		read: async (path) => {
			if (path === 'app.js') throw new Error('read boom')
			return new TextEncoder().encode('GUI2')
		}
	}
	await expect(s.install(broken)).rejects.toThrow('read boom')

	const installed = await s.get(id)
	if (!installed) throw new Error('expected v1 still installed')
	expect(decode(await installed.read('app.js'))).toBe('REDUCER')
	expect(decode(await installed.read('gui.js'))).toBe('GUI')
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

	const days = await vol.readdir('/trash')
	expect(days).toHaveLength(1)
	const day = days[0]?.name ?? ''
	expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
	const entries = await vol.readdir(`/trash/${day}`)
	expect(entries).toHaveLength(1)
	const name = entries[0]?.name ?? ''
	expect(name.startsWith(`${id}-`)).toBe(true)
	const manifest = JSON.parse(
		decode(await vol.readFile(`/trash/${day}/${name}/manifest.json`))
	) as {
		id: string
	}
	expect(manifest.id).toBe(id)
})

test('uninstall sweeps the cache mirror — no trash, nothing left to orphan', async () => {
	const vol = volume(memStorage())
	const s = apps(vol)
	const id = await s.install(cachedBundle({ app: 'REDUCER', gui: 'GUI' }))
	await s.uninstall(id)

	expect(await s.has(id)).toBe(false)
	expect(await vol.exists(cachePath(`/applications/${id}`))).toBe(false)
	// Only the synced half is recoverable, and that is the half that carries meaning:
	// the cache is refetchable bytes, so trashing it would buy nothing.
	const day = (await vol.readdir('/trash'))[0]?.name ?? ''
	const entry = (await vol.readdir(`/trash/${day}`))[0]?.name ?? ''
	expect(await vol.exists(`/trash/${day}/${entry}/app.js`)).toBe(true)
})

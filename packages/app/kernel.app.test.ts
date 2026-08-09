import { memStorage, volume } from '@justfiles/fs'
import { expect, test } from 'vitest'
import { type AppBundle, type AppManifest, appBundleFromMemory } from './app.ts'
import { apps } from './kernel.app.ts'

// The app store in isolation — no kernel, no sandbox, just a fs. Covers the
// `/applications/<id>` layout for both app shapes (bytes in the volume, and a hosted
// record whose payload is mounted from an origin), the install-existence guards, and
// the rollback contract: a failed install must not corrupt the previously installed app.

const store = () => apps(volume(memStorage()))
const decode = (b: Uint8Array) => new TextDecoder().decode(b)
const enc = (s: string) => new TextEncoder().encode(s)

async function sha256(data: Uint8Array): Promise<string> {
	const buffer = data.buffer.slice(
		data.byteOffset,
		data.byteOffset + data.byteLength
	) as ArrayBuffer
	const digest = await crypto.subtle.digest('SHA-256', buffer)
	return `sha256-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

// A hosted app: the record names an origin and pins each MOUNTED file's hash. The
// reducer is carried in the bundle and copied into the volume, like the installer does
// — a headless kernel has to be able to run it without reaching the origin.
async function hostedBundle(
	files: { app: string; gui: string },
	opts: { id?: string; baseUrl?: string } = {}
): Promise<AppBundle> {
	const manifest: AppManifest = {
		id: opts.id ?? 'com.example.app',
		name: 'App',
		version: '1.0.0',
		app: 'app.js',
		gui: 'gui.js',
		baseUrl: opts.baseUrl ?? '/appstore/apps/com.example.app/1.0.0',
		files: { 'gui.js': await sha256(enc(files.gui)) }
	}
	return {
		manifest: async () => manifest,
		list: async function* () {
			yield 'app.js'
		},
		read: async (p) => {
			if (p === 'app.js') return enc(files.app)
			throw new Error(`no local file: ${p}`)
		}
	}
}

function origin(served: Record<string, string>) {
	const requested: string[] = []
	const fetchAsset = async (url: string) => {
		requested.push(url)
		const path = url.split('/').pop() ?? ''
		const body = served[path]
		if (body === undefined) throw new Error(`404 ${url}`)
		return enc(body)
	}
	return { fetchAsset, requested }
}

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

// ── hosted apps: the manifest is the app, the payload is a mount ──────────────

test('installing a hosted app writes the record and the reducer, nothing else', async () => {
	const vol = volume(memStorage())
	const s = apps(vol, origin({}).fetchAsset)
	const id = await s.install(await hostedBundle({ app: 'REDUCER', gui: 'GUI' }))

	// The reducer is durable: a headless kernel runs it with no origin to reach.
	expect(decode(await vol.readFile(`/applications/${id}/app.js`))).toBe('REDUCER')
	expect(await vol.exists(`/applications/${id}/manifest.json`)).toBe(true)
	// The GUI is not, and nothing was fetched to install.
	expect(await vol.exists(`/applications/${id}/gui.js`)).toBe(false)
})

test('the reducer of a hosted app is read from the volume, never mounted', async () => {
	const vol = volume(memStorage())
	const o = origin({ 'gui.js': 'GUI' })
	// No fetcher at all: the reducer must still be readable.
	const id = await apps(vol).install(await hostedBundle({ app: 'REDUCER', gui: 'GUI' }))
	const installed = await apps(vol, o.fetchAsset).get(id)
	if (!installed) throw new Error('expected installed')

	expect(decode(await installed.read('app.js'))).toBe('REDUCER')
	expect(o.requested).toEqual([])
})

test('reading a hosted file goes through the host fetch layer, never the volume', async () => {
	const vol = volume(memStorage())
	const o = origin({ 'app.js': 'REDUCER', 'gui.js': 'GUI' })
	const s = apps(vol, o.fetchAsset)
	const id = await s.install(await hostedBundle({ app: 'REDUCER', gui: 'GUI' }))

	const installed = await s.get(id)
	if (!installed) throw new Error('expected installed')
	expect(decode(await installed.read('gui.js'))).toBe('GUI')
	expect(o.requested).toEqual(['/appstore/apps/com.example.app/1.0.0/gui.js'])
	expect(await vol.exists(`/applications/${id}/gui.js`)).toBe(false)

	// The browser host may satisfy this second request from its SW cache; this layer
	// deliberately makes the same fetch and integrity-check either way.
	expect(decode(await installed.read('gui.js'))).toBe('GUI')
	expect(o.requested).toHaveLength(2)
})

test('a mounted file that does not match its pinned hash is refused and evicted', async () => {
	const vol = volume(memStorage())
	// The record pins the real bytes; the origin serves something else.
	const o = origin({ 'gui.js': 'TAMPERED' })
	const evicted: string[] = []
	const fetchAsset = Object.assign(o.fetchAsset, {
		evict: async (url: string) => {
			evicted.push(url)
		}
	})
	const s = apps(vol, fetchAsset)
	const id = await s.install(await hostedBundle({ app: 'REDUCER', gui: 'GUI' }))

	const installed = await s.get(id)
	await expect(installed?.read('gui.js')).rejects.toThrow(/hash mismatch/)
	expect(evicted).toEqual(['/appstore/apps/com.example.app/1.0.0/gui.js'])
})

test('a host with no asset fetcher cannot mount, but still runs the reducer', async () => {
	const vol = volume(memStorage())
	const s = apps(vol)
	const id = await s.install(await hostedBundle({ app: 'REDUCER', gui: 'GUI' }))
	const installed = await s.get(id)
	expect(decode(await installed!.read('app.js'))).toBe('REDUCER')
	await expect(installed?.read('gui.js')).rejects.toThrow(/no asset fetcher/)
})

test('a hosted record naming an entry its origin will not serve is rejected at install', async () => {
	// The bytes are not here to check, so the pinned file list stands in — the failure
	// surfaces at install rather than at launch.
	const vol = volume(memStorage())
	const bundle = await hostedBundle({ app: 'REDUCER', gui: 'GUI' })
	const manifest = await bundle.manifest()
	const unpinned: AppBundle = { ...bundle, manifest: async () => ({ ...manifest, files: {} }) }
	await expect(apps(vol, origin({}).fetchAsset).install(unpinned)).rejects.toThrow(
		/missing gui entry/
	)
})

// The migration: an app installed the old way (every file copied in and replicated)
// is replaced by a record, and `install` replaces the whole app root — so the synced
// copies are deleted and that delete propagates.
test('reinstalling a copied app as hosted removes its bytes from the volume', async () => {
	const vol = volume(memStorage())
	const s = apps(vol, origin({ 'gui.js': 'GUI' }).fetchAsset)
	const id = await s.install(
		appBundleFromMemory({ id: 'com.example.app', name: 'App', app: 'REDUCER', gui: 'GUI' })
	)
	expect(await vol.exists(`/applications/${id}/gui.js`)).toBe(true)

	await s.install(await hostedBundle({ app: 'REDUCER', gui: 'GUI' }))

	// The GUI's copy is gone — that delete is the storage win — and the reducer stays.
	expect(await vol.exists(`/applications/${id}/gui.js`)).toBe(false)
	expect(decode(await vol.readFile(`/applications/${id}/app.js`))).toBe('REDUCER')
})

// ── staging ──────────────────────────────────────────────────────────────────

test('every staged byte is written under /private, never a synced path', async () => {
	// Staged bytes exist only to be renamed away, so they must never reach the wire.
	// This used to churn `/system/tmp` on every locally-authored install.
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
	await apps(spy).install(
		appBundleFromMemory({ id: 'com.example.app', name: 'App', app: 'CODE', gui: 'GUI' })
	)

	expect(seen.length).toBeGreaterThan(0)
	for (const path of seen) expect(path.startsWith('/private/tmp/')).toBe(true)
	expect(await vol.exists('/system/tmp/app-installs')).toBe(false)
})

test('the rename that commits an install carries its content out of /private', async () => {
	// Staging in an un-synced lane only works if the cross-lane rename is a real
	// commit: the bytes have to land in `/applications` readable, not just linked.
	const vol = volume(memStorage())
	const s = apps(vol)
	const id = await s.install(
		appBundleFromMemory({ id: 'com.example.app', name: 'App', app: 'CODE', gui: 'GUI' })
	)

	expect(decode(await vol.readFile(`/applications/${id}/app.js`))).toBe('CODE')
	expect(await vol.readdir('/private/tmp/app-installs')).toEqual([])
})

// ── uninstall ────────────────────────────────────────────────────────────────

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

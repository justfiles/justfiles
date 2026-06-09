import { memStorage, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import type { CapabilityCall } from '../types.ts'
import { volumeCapability } from './host.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()
const tick = () => new Promise((r) => setTimeout(r, 10))

// A `volume` CapabilityCall: defaults to the per-app scope; override appId/scopes
// per test. `args` is the method's positional argument list (the contract now IS
// `Volume`, so e.g. writeFile takes (path, data)); `scan`/`watch` keep a single
// options object.
const call = (method: string, args: unknown[], x?: Partial<CapabilityCall>): CapabilityCall => ({
	appId: 'app',
	capability: 'volume',
	method,
	args,
	scopes: ['app'],
	...x
})

function setup() {
	const fs = volume(memStorage())
	return { fs, cap: volumeCapability(fs, { systemAllowlist: ['app.trusted'] }) }
}

async function seed(fs: ReturnType<typeof volume>, path: string, body: string) {
	const parent = path.split('/').slice(0, -1).join('/')
	if (parent) await fs.mkdir(parent, { recursive: true })
	await fs.writeFile(path, enc.encode(body))
}

describe('volume capability', () => {
	test('scope=app chroots reads to /data/<id>', async () => {
		const { fs, cap } = setup()
		await seed(fs, '/data/com.example.app/note.txt', 'hello')
		const data = (await cap.invoke(
			call('readFile', ['/note.txt'], { appId: 'com.example.app' })
		)) as Uint8Array
		expect(dec.decode(data)).toBe('hello')
	})

	test('scope=app writes land under the per-app prefix only', async () => {
		const { fs, cap } = setup()
		await cap.invoke(
			call('writeFile', ['/inside.txt', enc.encode('x')], { appId: 'com.example.app' })
		)
		expect(await fs.exists('/data/com.example.app/inside.txt')).toBe(true)
		expect(await fs.exists('/inside.txt')).toBe(false)
	})

	test('scope=app cannot escape its chroot via host-absolute path', async () => {
		const { fs, cap } = setup()
		await seed(fs, '/system-secret.txt', 'nope')
		await expect(
			cap.invoke(call('readFile', ['/system-secret.txt'], { appId: 'com.example.app' }))
		).rejects.toThrow()
	})

	test('scope=system grants the root volume to allowlisted apps', async () => {
		const { fs, cap } = setup()
		await seed(fs, '/outside.txt', 'top-level')
		const data = (await cap.invoke(
			call('readFile', ['/outside.txt'], { appId: 'app.trusted', scopes: ['system'] })
		)) as Uint8Array
		expect(dec.decode(data)).toBe('top-level')
	})

	test('scope=system is rejected for non-allowlisted apps', async () => {
		const { cap } = setup()
		await expect(
			cap.invoke(
				call('readFile', ['/outside.txt'], {
					appId: 'com.example.untrusted',
					scopes: ['system']
				})
			)
		).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
	})

	test('/system prefix scope is rejected without the system scope', async () => {
		const { cap } = setup()
		await expect(
			cap.invoke(
				call('readFile', ['/profiles/user.md'], {
					appId: 'com.example.snooper',
					scopes: ['/system']
				})
			)
		).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
		await expect(
			cap.invoke(
				call('readFile', ['/user.md'], {
					appId: 'com.example.snooper',
					scopes: ['/system/profiles']
				})
			)
		).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
	})

	test('absolute-prefix scope binds a chroot at that prefix', async () => {
		const { fs, cap } = setup()
		await seed(fs, '/Paint/picture.png', 'png-bytes')
		const data = (await cap.invoke(
			call('readFile', ['/picture.png'], { appId: 'com.example.paint', scopes: ['/Paint'] })
		)) as Uint8Array
		expect(dec.decode(data)).toBe('png-bytes')
	})

	test('scan returns flat dir listing tagged with type', async () => {
		const { fs, cap } = setup()
		await seed(fs, '/data/x/a.txt', 'a')
		await seed(fs, '/data/x/sub/b.txt', 'b')
		const entries = (await cap.invoke(call('scan', [{ path: '/' }], { appId: 'x' }))) as Array<{
			path: string
			type: 'file' | 'dir'
		}>
		expect(entries.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
			{ path: '/a.txt', type: 'file' },
			{ path: '/sub', type: 'dir' }
		])
	})

	test('scan with recursive=true returns the full descendant tree', async () => {
		const { fs, cap } = setup()
		await seed(fs, '/data/x/a.txt', 'a')
		await seed(fs, '/data/x/sub/b.txt', 'b')
		await seed(fs, '/data/x/sub/deep/c.txt', 'c')
		const entries = (await cap.invoke(
			call('scan', [{ path: '/', recursive: true }], { appId: 'x' })
		)) as Array<{ path: string; type: 'file' | 'dir' }>
		expect(entries.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
			{ path: '/a.txt', type: 'file' },
			{ path: '/sub', type: 'dir' },
			{ path: '/sub/b.txt', type: 'file' },
			{ path: '/sub/deep', type: 'dir' },
			{ path: '/sub/deep/c.txt', type: 'file' }
		])
	})

	test('exists reports presence without throwing on a missing path', async () => {
		const { fs, cap } = setup()
		await seed(fs, '/data/x/there.txt', 'hi')
		const present = await cap.invoke(call('exists', ['/there.txt'], { appId: 'x' }))
		const missing = await cap.invoke(call('exists', ['/missing.txt'], { appId: 'x' }))
		expect(present).toBe(true)
		expect(missing).toBe(false)
	})

	test('mkdir creates intermediate dirs when recursive', async () => {
		const { fs, cap } = setup()
		await cap.invoke(call('mkdir', ['/deeply/nested/dir', { recursive: true }], { appId: 'x' }))
		expect(await fs.exists('/data/x/deeply/nested/dir')).toBe(true)
	})

	test('rm drops a subtree; rename moves it', async () => {
		const { cap } = setup()
		await cap.invoke(
			call('writeFile', ['/projects/a/x.txt', enc.encode('hi')], { appId: 'app.code' })
		)
		await cap.invoke(call('rename', ['/projects/a', '/projects/b'], { appId: 'app.code' }))
		expect(await cap.invoke(call('exists', ['/projects/a/x.txt'], { appId: 'app.code' }))).toBe(
			false
		)
		expect(await cap.invoke(call('exists', ['/projects/b/x.txt'], { appId: 'app.code' }))).toBe(
			true
		)
		await cap.invoke(call('rm', ['/projects/b', { recursive: true }], { appId: 'app.code' }))
		expect(await cap.invoke(call('exists', ['/projects/b'], { appId: 'app.code' }))).toBe(false)
	})

	test('a multi-arg method reused from Volume: cp copies a file', async () => {
		const { cap } = setup()
		await cap.invoke(call('writeFile', ['/src.txt', enc.encode('copy me')], { appId: 'x' }))
		await cap.invoke(call('cp', ['/src.txt', '/dest.txt'], { appId: 'x' }))
		const data = (await cap.invoke(call('readFile', ['/dest.txt'], { appId: 'x' }))) as Uint8Array
		expect(dec.decode(data)).toBe('copy me')
	})

	test('watch emits when the watched file changes', async () => {
		const { cap } = setup()
		const seen: unknown[] = []
		const unsub = await cap.subscribe(call('watch', [{ path: '/a.txt' }], { appId: 'app1' }), (e) =>
			seen.push(e)
		)
		await cap.invoke(call('writeFile', ['/a.txt', enc.encode('yo')], { appId: 'app1' }))
		await tick()
		expect(seen.length).toBeGreaterThan(0)
		unsub()
	})

	test('rejects unknown methods', async () => {
		const { cap } = setup()
		await expect(cap.invoke(call('frobnicate', [{}], { appId: 'x' }))).rejects.toMatchObject({
			code: 'CAPABILITY_UNAVAILABLE'
		})
	})
})

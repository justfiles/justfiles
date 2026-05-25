import { memStorage, volume } from '@justfiles/fs'
import { describe, expect, test } from 'vitest'
import { invokeVolume } from './volume.capability.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

function setup() {
	const fs = volume(memStorage())
	return { fs }
}

async function seed(fs: ReturnType<typeof volume>, path: string, body: string) {
	const parent = path.split('/').slice(0, -1).join('/')
	if (parent) await fs.mkdir(parent, { recursive: true })
	await fs.writeFile(path, enc.encode(body))
}

describe('volume capability', () => {
	test('scope=app chroots reads to /applications/<id>/data/files', async () => {
		const { fs } = setup()
		await seed(fs, '/applications/com.example.app/data/files/note.txt', 'hello')
		const data = (await invokeVolume(fs, {
			appId: 'com.example.app',
			method: 'readFile',
			input: { path: '/note.txt' },
			scopes: ['app']
		})) as Uint8Array
		expect(dec.decode(data)).toBe('hello')
	})

	test('scope=app writes land under the per-app prefix only', async () => {
		const { fs } = setup()
		await invokeVolume(fs, {
			appId: 'com.example.app',
			method: 'writeFile',
			input: { path: '/inside.txt', data: enc.encode('x') },
			scopes: ['app']
		})
		expect(await fs.exists('/applications/com.example.app/data/files/inside.txt')).toBe(true)
		expect(await fs.exists('/inside.txt')).toBe(false)
	})

	test('scope=app cannot escape its chroot via host-absolute path', async () => {
		const { fs } = setup()
		await seed(fs, '/system-secret.txt', 'nope')
		await expect(
			invokeVolume(fs, {
				appId: 'com.example.app',
				method: 'readFile',
				input: { path: '/system-secret.txt' },
				scopes: ['app']
			})
		).rejects.toThrow()
	})

	test('scope=system grants the root volume', async () => {
		const { fs } = setup()
		await seed(fs, '/outside.txt', 'top-level')
		const data = (await invokeVolume(fs, {
			appId: 'com.example.trusted',
			method: 'readFile',
			input: { path: '/outside.txt' },
			scopes: ['system']
		})) as Uint8Array
		expect(dec.decode(data)).toBe('top-level')
	})

	test('absolute-prefix scope binds a chroot at that prefix', async () => {
		const { fs } = setup()
		await seed(fs, '/Paint/picture.png', 'png-bytes')
		const data = (await invokeVolume(fs, {
			appId: 'com.example.paint',
			method: 'readFile',
			input: { path: '/picture.png' },
			scopes: ['/Paint']
		})) as Uint8Array
		expect(dec.decode(data)).toBe('png-bytes')
	})

	test('scan returns flat dir listing tagged with type', async () => {
		const { fs } = setup()
		await seed(fs, '/applications/x/data/files/a.txt', 'a')
		await seed(fs, '/applications/x/data/files/sub/b.txt', 'b')
		const entries = (await invokeVolume(fs, {
			appId: 'x',
			method: 'scan',
			input: { path: '/' },
			scopes: ['app']
		})) as Array<{ path: string; type: 'file' | 'dir' }>
		expect(entries.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
			{ path: '/a.txt', type: 'file' },
			{ path: '/sub', type: 'dir' }
		])
	})

	test('exists reports presence without throwing on a missing path', async () => {
		const { fs } = setup()
		await seed(fs, '/applications/x/data/files/there.txt', 'hi')
		const present = await invokeVolume(fs, {
			appId: 'x',
			method: 'exists',
			input: { path: '/there.txt' },
			scopes: ['app']
		})
		const missing = await invokeVolume(fs, {
			appId: 'x',
			method: 'exists',
			input: { path: '/missing.txt' },
			scopes: ['app']
		})
		expect(present).toBe(true)
		expect(missing).toBe(false)
	})

	test('mkdir creates intermediate dirs by default', async () => {
		const { fs } = setup()
		await invokeVolume(fs, {
			appId: 'x',
			method: 'mkdir',
			input: { path: '/deeply/nested/dir' },
			scopes: ['app']
		})
		expect(await fs.exists('/applications/x/data/files/deeply/nested/dir')).toBe(true)
	})

	test('rejects unknown methods', async () => {
		const { fs } = setup()
		await expect(
			invokeVolume(fs, { appId: 'x', method: 'rm', input: { path: '/' }, scopes: ['app'] })
		).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
	})

	test('rejects malformed input', async () => {
		const { fs } = setup()
		await expect(
			invokeVolume(fs, { appId: 'x', method: 'readFile', input: {}, scopes: ['app'] })
		).rejects.toMatchObject({ code: 'CAPABILITY_INVALID_INPUT' })
	})
})

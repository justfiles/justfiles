import { expect, test } from 'bun:test'
import { APP_CONTRACT_VERSION, NotFoundError } from './contract.js'
import { createHost, type VolumeBackend } from './host-factory.js'

function memBackend(): VolumeBackend & { files: Map<string, Uint8Array> } {
	const files = new Map<string, Uint8Array>()
	return {
		files,
		async readFile(path) {
			const v = files.get(path)
			if (!v) throw new Error(`ENOENT: ${path}`)
			return v
		},
		async writeFile(path, data) {
			files.set(path, data)
		},
		async mkdir() {}
	}
}

test('createHost returns a Host with the contract version', () => {
	const host = createHost({ appId: 'demo', volume: memBackend() })
	expect(host.version).toBe(APP_CONTRACT_VERSION)
})

test('createHost yields a fresh instance per call', () => {
	const backend = memBackend()
	const a = createHost({ appId: 'demo', volume: backend })
	const b = createHost({ appId: 'demo', volume: backend })
	expect(a).not.toBe(b)
	expect(a.volume).not.toBe(b.volume)
})

test('volume.writeText/readText round-trip via the backend', async () => {
	const backend = memBackend()
	const host = createHost({ appId: 'demo', volume: backend })
	await host.volume.writeText('greeting.txt', 'hello')
	expect(await host.volume.readText('greeting.txt')).toBe('hello')
})

test('volume scopes paths under /apps/<appId>/private/', async () => {
	const backend = memBackend()
	const host = createHost({ appId: 'demo', volume: backend })
	await host.volume.writeText('a/b.txt', 'x')
	expect([...backend.files.keys()]).toEqual(['/apps/demo/private/a/b.txt'])
})

test('two mounts of the same app id do not see each other when backends differ', async () => {
	const a = createHost({ appId: 'demo', volume: memBackend() })
	const b = createHost({ appId: 'demo', volume: memBackend() })
	await a.volume.writeText('shared.txt', 'from-a')
	await expect(b.volume.readText('shared.txt')).rejects.toThrow(NotFoundError)
})

test('two mounts with different app ids do not collide on the same backend', async () => {
	const backend = memBackend()
	const a = createHost({ appId: 'one', volume: backend })
	const b = createHost({ appId: 'two', volume: backend })
	await a.volume.writeText('shared.txt', 'from-a')
	await b.volume.writeText('shared.txt', 'from-b')
	expect(await a.volume.readText('shared.txt')).toBe('from-a')
	expect(await b.volume.readText('shared.txt')).toBe('from-b')
})

test('volume.readText throws NotFoundError when the file does not exist', async () => {
	const host = createHost({ appId: 'demo', volume: memBackend() })
	await expect(host.volume.readText('missing.txt')).rejects.toThrow(NotFoundError)
})

test('volume rejects path-escape attempts', async () => {
	const host = createHost({ appId: 'demo', volume: memBackend() })
	await expect(host.volume.readText('../escape.txt')).rejects.toThrow(/not allowed/)
	await expect(host.volume.readText('')).rejects.toThrow(/non-empty/)
})

test('volume propagates non-ENOENT backend errors verbatim', async () => {
	const backend: VolumeBackend = {
		async readFile() {
			throw new Error('disk on fire')
		},
		async writeFile() {},
		async mkdir() {}
	}
	const host = createHost({ appId: 'demo', volume: backend })
	await expect(host.volume.readText('x.txt')).rejects.toThrow('disk on fire')
})

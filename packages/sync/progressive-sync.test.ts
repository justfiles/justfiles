import { volume } from '@justfiles/fs'
import type { Storage } from '@justfiles/fs/storage'
import { FileType } from '@justfiles/fs/types'
import { expect, test } from 'vitest'
import { hashBytes } from './content'
import { storageSyncReplica } from './index'
import type { SyncCapableStorage } from './node'
import { nodeMemStorage } from './storage/node-mem'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const text = (value: Uint8Array): string => new TextDecoder().decode(value)

function withoutSync(storage: SyncCapableStorage): Storage {
	const { sync: _sync, ...caps } = storage.caps
	return { ...storage, caps }
}

function withoutContent(storage: SyncCapableStorage): Storage {
	const { content: _content, ...caps } = storage.caps
	return { ...storage, caps }
}

function scanningReplica(storage: Storage) {
	const selected = storageSyncReplica(storage)
	if (selected.strategy !== 'scan') throw new Error('expected scan sync')
	return selected.replica
}

function baseOnly(storage: SyncCapableStorage, calls: { reads: number; writes: number }): Storage {
	const { caps: _caps, ...base } = storage
	return {
		...base,
		async getBlob(ino) {
			calls.reads++
			return base.getBlob(ino)
		},
		async putBlob(ino, data, options) {
			calls.writes++
			return base.putBlob(ino, data, options)
		}
	}
}

test('content-only storage reconciles scans, deduplicates bytes, and permits rename fanout', async () => {
	const sourceStorage = withoutSync(nodeMemStorage())
	const targetStorage = withoutSync(nodeMemStorage())
	const source = scanningReplica(sourceStorage)
	const target = scanningReplica(targetStorage)
	const sourceVolume = volume(sourceStorage)
	const targetVolume = volume(targetStorage)
	const fetched: string[] = []

	await sourceVolume.mkdir('/old')
	await sourceVolume.writeFile('/old/a.txt', bytes('same'))
	await sourceVolume.writeFile('/old/b.txt', bytes('same'))
	let snapshot = await source.scan()
	await target.apply(snapshot.entries, async (hash) => {
		fetched.push(hash)
		return snapshot.getBlobByHash(hash)
	})
	await snapshot.close()

	expect(text(await targetVolume.readFile('/old/a.txt'))).toBe('same')
	expect(text(await targetVolume.readFile('/old/b.txt'))).toBe('same')
	expect(new Set(fetched).size).toBe(1)
	expect(fetched).toHaveLength(1)

	fetched.length = 0
	await sourceVolume.rename('/old', '/new')
	snapshot = await source.scan()
	await target.apply(snapshot.entries, async (hash) => {
		fetched.push(hash)
		return snapshot.getBlobByHash(hash)
	})
	await snapshot.close()

	expect(await targetVolume.exists('/old')).toBe(false)
	expect(text(await targetVolume.readFile('/new/b.txt'))).toBe('same')
	expect(fetched).toEqual([])
})

test('full scan preserves symlink metadata without changing its target', async () => {
	const sourceStorage = withoutSync(nodeMemStorage())
	const targetStorage = withoutSync(nodeMemStorage())
	const source = scanningReplica(sourceStorage)
	const target = scanningReplica(targetStorage)
	const sourceVolume = volume(sourceStorage)
	const targetVolume = volume(targetStorage)

	await sourceVolume.writeFile('/target.txt', bytes('target'))
	await sourceVolume.chmod('/target.txt', 0o640)
	await sourceVolume.symlink('/target.txt', '/link')
	const sourceLink = await sourceVolume.lstat('/link')
	await sourceStorage.setMeta(sourceLink.ino, { mode: 0o701, mtimeNs: 123_456_789n })
	await sourceStorage.caps?.setXattr?.(sourceLink.ino, 'user.link', bytes('metadata'))

	const snapshot = await source.scan()
	await target.apply(snapshot.entries, (hash) => snapshot.getBlobByHash(hash))
	await snapshot.close()

	const targetLink = await targetVolume.lstat('/link')
	expect(targetLink.mode).toBe(0o701)
	expect(targetLink.mtimeNs).toBe(123_456_789n)
	expect(await targetStorage.caps?.getXattr?.(targetLink.ino, 'user.link')).toEqual(
		bytes('metadata')
	)
	expect((await targetVolume.lstat('/target.txt')).mode).toBe(0o640)
})

test('full scan treats xattr enumeration order as insignificant', async () => {
	const base = withoutSync(nodeMemStorage())
	const fs = volume(base)
	await fs.writeFile('/note.txt', bytes('note'))
	const ino = (await fs.lstat('/note.txt')).ino
	await base.caps?.setXattr?.(ino, 'user.a', bytes('a'))
	await base.caps?.setXattr?.(ino, 'user.b', bytes('b'))
	const baseCaps = base.caps
	let listings = 0
	const storage: Storage = {
		...base,
		caps: {
			...baseCaps,
			async listXattrs(inode) {
				listings++
				if (listings > 2) throw new Error('equivalent scans kept retrying')
				const names = (await baseCaps?.listXattrs?.(inode)) ?? []
				return listings % 2 === 1 ? names : [...names].reverse()
			}
		}
	}

	const snapshot = await scanningReplica(storage).scan()

	expect(snapshot.entries[0]?.meta.xattrs).toEqual({
		'user.a': 'YQ==',
		'user.b': 'Yg=='
	})
	await snapshot.close()
})

test('full scan reconciles a target lazy stub without reading its bytes', async () => {
	const storage = withoutSync(nodeMemStorage())
	const fs = volume(storage)
	const hash = await hashBytes(bytes('remote'))
	await storage.setMeta('lazy', {
		type: FileType.Regular,
		size: 6n,
		mode: 0o644,
		mtimeNs: 0n,
		ctimeNs: 0n,
		contentHash: hash
	})
	await storage.putDirent(storage.rootIno, 'lazy.txt', {
		ino: 'lazy',
		type: FileType.Regular
	})

	await scanningReplica(storage).apply([], () => Promise.reject(new Error('unexpected fetch')))

	expect(await fs.exists('/lazy.txt')).toBe(false)
})

test('full scan hydrates a matching target lazy stub', async () => {
	const sourceStorage = withoutSync(nodeMemStorage())
	const targetStorage = withoutSync(nodeMemStorage())
	const source = scanningReplica(sourceStorage)
	const target = scanningReplica(targetStorage)
	const sourceVolume = volume(sourceStorage)
	const targetVolume = volume(targetStorage)
	await sourceVolume.writeFile('/lazy.txt', bytes('remote'))
	const snapshot = await source.scan()
	const hash = snapshot.entries[0]?.contentHash
	if (!hash) throw new Error('missing source content hash')
	await targetStorage.setMeta('lazy', {
		type: FileType.Regular,
		size: 6n,
		mode: 0o644,
		mtimeNs: 0n,
		ctimeNs: 0n,
		contentHash: hash
	})
	await targetStorage.putDirent(targetStorage.rootIno, 'lazy.txt', {
		ino: 'lazy',
		type: FileType.Regular
	})

	await target.apply(snapshot.entries, (contentHash) => snapshot.getBlobByHash(contentHash))
	await snapshot.close()

	expect(text(await targetVolume.readFile('/lazy.txt'))).toBe('remote')
})

test('base storage converges quiescent create, update, rename, and delete through inode blobs', async () => {
	const sourceCalls = { reads: 0, writes: 0 }
	const targetCalls = { reads: 0, writes: 0 }
	const sourceStorage = baseOnly(nodeMemStorage(), sourceCalls)
	const targetStorage = baseOnly(nodeMemStorage(), targetCalls)
	const source = scanningReplica(sourceStorage)
	const target = scanningReplica(targetStorage)
	const sourceVolume = volume(sourceStorage)
	const targetVolume = volume(targetStorage)

	await sourceVolume.mkdir('/docs')
	await sourceVolume.writeFile('/docs/keep.txt', bytes('old'))
	await sourceVolume.writeFile('/docs/gone.txt', bytes('gone'))
	let snapshot = await source.scan()
	await target.apply(snapshot.entries, (hash) => snapshot.getBlobByHash(hash))
	await snapshot.close()

	sourceCalls.reads = 0
	targetCalls.writes = 0
	await sourceVolume.writeFile('/docs/keep.txt', bytes('new'))
	await sourceVolume.writeFile('/fresh.txt', bytes('fresh'))
	await sourceVolume.rename('/docs', '/moved')
	await sourceVolume.rm('/moved/gone.txt')
	snapshot = await source.scan()
	await target.apply(snapshot.entries, (hash) => snapshot.getBlobByHash(hash))
	await snapshot.close()

	expect(await targetVolume.exists('/docs')).toBe(false)
	expect(await targetVolume.exists('/moved/gone.txt')).toBe(false)
	expect(text(await targetVolume.readFile('/moved/keep.txt'))).toBe('new')
	expect(text(await targetVolume.readFile('/fresh.txt'))).toBe('fresh')
	expect(sourceCalls.reads).toBeGreaterThan(0)
	expect(targetCalls.writes).toBeGreaterThan(0)
	expect(sourceStorage.caps).toBeUndefined()
	expect(targetStorage.caps).toBeUndefined()
})

test.each([
	[
		'sync and content',
		(storage: SyncCapableStorage): Storage => storage,
		'incremental',
		'addressed'
	],
	['sync only', withoutContent, 'incremental', 'ordinary'],
	['content only', withoutSync, 'scan', 'addressed'],
	[
		'base storage',
		(storage: SyncCapableStorage) => baseOnly(storage, { reads: 0, writes: 0 }),
		'scan',
		'ordinary'
	]
] as const)('%s selects one progressive strategy', (_label, refine, strategy, content) => {
	const selected = storageSyncReplica(refine(nodeMemStorage()))
	expect(selected).toMatchObject({ strategy, content })
})

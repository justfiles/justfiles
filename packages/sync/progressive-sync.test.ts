import { volume } from '@justfiles/fs'
import type { Storage } from '@justfiles/fs/storage'
import { expect, test } from 'vitest'
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

import 'fake-indexeddb/auto'
import { volume } from '@justfiles/fs'
import { FileType } from '@justfiles/fs/types'
import { openDB } from 'idb'
import { expect, test } from 'vitest'
import { idbStorage } from './storage/idb'
import { storageSyncReplica } from './strategy'
import type { PathChange } from './wire'

const contentHash = '7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed'
const meta = {
	type: FileType.Regular,
	mode: 0o644,
	mtimeNs: '0',
	size: '3'
}

async function seedV7(name: string): Promise<void> {
	const db = await openDB(name, 7, {
		upgrade(db) {
			db.createObjectStore('inodes', { keyPath: 'ino' })
			const content = db.createObjectStore('content', { keyPath: 'contentHash' })
			content.createIndex('by-lru', 'lastAccessedAt')
			const dirs = db.createObjectStore('dirs', { keyPath: ['dirIno', 'name'] })
			dirs.createIndex('by-dir', 'dirIno')
			dirs.createIndex('by-ino', 'ino')
			const xattrs = db.createObjectStore('xattrs', { keyPath: ['ino', 'name'] })
			xattrs.createIndex('by-ino', 'ino')
			db.createObjectStore('dirty', { keyPath: 'ino' })
			db.createObjectStore('meta')
			const journal = db.createObjectStore('journal', { keyPath: 'seq', autoIncrement: true })
			journal.createIndex('by-path', 'change.path')
			db.createObjectStore('pathver', { keyPath: 'path' })
		}
	})
	const stamp = 1n
	await db.put('inodes', {
		ino: '1',
		type: FileType.Directory,
		size: 0n,
		mode: 0o755,
		mtimeNs: stamp,
		ctimeNs: stamp,
		lastAccessedAt: 1
	} as never)
	await db.put('inodes', {
		ino: 'note-ino',
		type: FileType.Regular,
		size: 3n,
		mode: 0o644,
		mtimeNs: stamp,
		ctimeNs: stamp,
		contentHash,
		lastAccessedAt: 1
	} as never)
	await db.put('content', {
		contentHash,
		data: new TextEncoder().encode('one'),
		sizeBytes: 3,
		lastAccessedAt: 1
	} as never)
	await db.put('dirs', {
		dirIno: '1',
		name: 'note.txt',
		ino: 'note-ino',
		type: FileType.Regular
	} as never)
	await db.put('dirty', { ino: 'note-ino', markedAt: 1 } as never)
	await db.put('meta', '1' as never, 'rootIno')
	await db.put('meta', 3 as never, 'totalContentBytes')
	await db.put('meta', { theme: 'dark' } as never, 'application')
	const put: PathChange = { kind: 'put', path: '/note.txt', version: '1', contentHash, meta }
	const gone: PathChange = { kind: 'delete', path: '/gone.txt', version: '2' }
	await db.add('journal', { change: put } as never)
	await db.add('journal', { change: gone } as never)
	await db.put('pathver', { path: '/note.txt', version: 1, tombstone: 0 } as never)
	await db.put('pathver', { path: '/gone.txt', version: 0, tombstone: 2 } as never)
	db.close()
}

test('the v8 upgrade preserves filesystem, dirty content, v1 sync, and application state', async () => {
	const name = `node-upgrade-${crypto.randomUUID()}`
	await seedV7(name)
	const storage = idbStorage(name, { contentCapBytes: 5 })
	const storageVolume = volume(storage)
	const selected = storageSyncReplica(storage)
	if (selected.strategy !== 'incremental') throw new Error('expected incremental sync')

	expect(new TextDecoder().decode(await storageVolume.readFile('/note.txt'))).toBe('one')
	expect((await selected.replica.nodeDeltas('', { limit: 10 })).operations).toEqual([])
	expect((await storage.sync.journal.readFrom(0, 10)).map((row) => row.change)).toEqual([
		expect.objectContaining({ kind: 'put', path: '/note.txt' }),
		expect.objectContaining({ kind: 'delete', path: '/gone.txt' })
	])
	expect(await storage.sync.pathApply.localChange('/gone.txt')).toEqual({
		kind: 'delete',
		path: '/gone.txt',
		version: '2',
		source: 'local'
	})

	await storageVolume.writeFile('/big.txt', new TextEncoder().encode('x'.repeat(20)))
	expect(new TextDecoder().decode(await storageVolume.readFile('/note.txt'))).toBe('one')
	const raw = await openDB(name)
	expect(await raw.get('meta', 'application')).toEqual({ theme: 'dark' })
	raw.close()
	storage.destroy()
})

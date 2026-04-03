import { afterEach, describe, expect, test } from 'bun:test'

import { idbStorage } from './storage.idb.ts'
import { FileType } from './types.ts'

const databases = []
const hasIndexedDb = typeof indexedDB !== 'undefined'

async function deleteDatabase(name) {
	await new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name)
		request.onsuccess = () => resolve()
		request.onerror = () => reject(request.error ?? new Error(`failed to delete ${name}`))
		request.onblocked = () => reject(new Error(`delete blocked for ${name}`))
	})
}

afterEach(async () => {
	if (!hasIndexedDb) return
	for (const { name, storage } of databases.splice(0)) {
		storage.destroy()
		await deleteDatabase(name)
	}
})

describe('idbStorage', () => {
	(hasIndexedDb ? test : test.skip)('updates compacts acknowledged outbound journal entries implicitly', async () => {
		const name = `ghostore-fs-test-${crypto.randomUUID()}`
		const storage = idbStorage(name)
		databases.push({ name, storage })

		const ino = await storage.alloc({
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})
		await storage.write(ino, 0n, new TextEncoder().encode('body'), { source: 'client-a' })
		await storage.setXattr?.(ino, 'user.title', new TextEncoder().encode('note'), { source: 'client-a' })

		expect(await storage.updates?.('')).toEqual({
			ops: [
				{
					kind: 'upsert-inode',
					source: 'client-a',
					ino,
					meta: expect.objectContaining({
						type: FileType.Regular,
						nlink: 0,
					}),
				},
				{
					kind: 'upsert-inode',
					source: 'client-a',
					ino,
					meta: expect.objectContaining({
						type: FileType.Regular,
						nlink: 0,
					}),
					xattrs: {
						'user.title': new TextEncoder().encode('note'),
					},
				},
			],
			cursor: '2',
		})

		expect(await storage.updates?.('1')).toEqual({
			ops: [
				{
					kind: 'upsert-inode',
					source: 'client-a',
					ino,
					meta: expect.objectContaining({
						type: FileType.Regular,
						nlink: 0,
					}),
					xattrs: {
						'user.title': new TextEncoder().encode('note'),
					},
				},
			],
			cursor: '2',
		})

		expect(await storage.updates?.('2')).toEqual({
			ops: [],
			cursor: '2',
		})

		expect(await storage.updates?.('')).toEqual({
			ops: [],
			cursor: '',
		})
	})
})

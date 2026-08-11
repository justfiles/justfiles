import 'fake-indexeddb/auto'
import { volume } from '@justfiles/fs'
import type { Storage } from '@justfiles/fs/storage'
import { idbStorage } from '@justfiles/fs/storage/idb'
import { memStorage } from '@justfiles/fs/storage/mem'
import { describe, expect, test } from 'vitest'

const bytes = new TextEncoder().encode('data')

async function exercise(storage: Storage): Promise<void> {
	const vol = volume(storage)
	await vol.mkdir('/dir')
	await vol.writeFile('/dir/file', bytes)
	await vol.setXattr('/dir/file', 'user.test', bytes)
	await vol.rename('/dir/file', '/dir/moved')
	await vol.rm('/dir', { recursive: true })
}

async function objectStoreNames(name: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name)
		request.onerror = () => reject(request.error)
		request.onsuccess = () => {
			const db = request.result
			const names = [...db.objectStoreNames]
			db.close()
			resolve(names)
		}
	})
}

describe('filesystem backends without a sync observer', () => {
	test('memory supports mutations without sync state', async () => {
		const storage = memStorage()
		await exercise(storage)
		expect(storage).not.toHaveProperty('sync')
	})

	test('IndexedDB supports mutations without sync stores', async () => {
		const name = `pure-${crypto.randomUUID()}`
		const storage = idbStorage(name)
		try {
			await exercise(storage)
			expect(storage).not.toHaveProperty('sync')
			expect(await objectStoreNames(name)).not.toEqual(
				expect.arrayContaining(['journal', 'pathver'])
			)
		} finally {
			storage.destroy()
		}
	})
})

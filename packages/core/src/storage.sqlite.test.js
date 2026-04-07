// @ts-ignore Bun resolves this at runtime; TypeScript in this workspace does not.
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { FsCursorExpiredError } from 'just-files'
import { FileType } from 'just-files/types'
import { createFsApi } from './fs'
import { createSqliteAdapter } from './db.sqlite'
import { storage as sqliteStorage } from './storage.sqlite'
import { parseSqlStatements } from './store'

async function createTestStorage(maxRetainedUpdates) {
	const db = new Database(':memory:')
	const adapter = createSqliteAdapter(db)
	for (const file of [
		'0001_schema.sql',
		'0002_dirty_flag.sql',
		'0003_drop_chunk_vectors.sql',
		'0004_reset_dirty.sql',
		'0005_fs_schema.sql',
		'0006_fs_updates_source.sql',
		'0007_fs_state.sql',
	]) {
		const sql = await Bun.file(new URL(`./migrations/${file}`, import.meta.url)).text()
		for (const statement of parseSqlStatements(sql)) {
			await adapter.run(statement)
		}
	}
	return sqliteStorage(adapter, { maxRetainedUpdates })
}

describe('sqlite fs update retention', () => {
	test('setMeta creates a missing inode when given a full inode snapshot', async () => {
		const backend = await createTestStorage(2)
		const ino = 'local-first-ino'

		await backend.setMeta(ino, {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			nlink: 0,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})

		expect(await backend.getMeta(ino)).toEqual({
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			nlink: 0,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})
	})

	test('setMeta creates a missing inode with defaults when type is present', async () => {
		const backend = await createTestStorage(2)
		const ino = 'partial-create-ino'

		await backend.setMeta(ino, {
			type: FileType.Regular,
		})

		expect(await backend.getMeta(ino)).toEqual(expect.objectContaining({
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			nlink: 0,
		}))
	})

	test('throws FsCursorExpiredError when the requested cursor has been pruned', async () => {
		const backend = await createTestStorage(2)
		const ino = await backend.create(backend.rootIno, 'note.txt', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})
		await backend.setMeta(ino, { mode: 0o600 })
		await backend.setMeta(ino, { mode: 0o644 })

		await expect(backend.updates('1')).rejects.toBeInstanceOf(FsCursorExpiredError)
		await expect(backend.updates('2')).resolves.toEqual({
			ops: [
				expect.objectContaining({ kind: 'upsert-inode', ino }),
				expect.objectContaining({ kind: 'upsert-inode', ino }),
			],
			cursor: '4',
		})
	})

	test('returns cursor_expired from the fs API when the backend cursor has been pruned', async () => {
		const backend = await createTestStorage(2)
		const ino = await backend.create(backend.rootIno, 'note.txt', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})
		await backend.setMeta(ino, { mode: 0o600 })
		await backend.setMeta(ino, { mode: 0o644 })

		const app = createFsApi(backend)
		const response = await app.request('/updates?cursor=1')

		expect(response.status).toBe(409)
		expect(await response.json()).toEqual({
			error: 'FS sync cursor expired: 1',
			code: 'cursor_expired',
		})
	})

	test('scan returns the update-log cursor only on the final page', async () => {
		const backend = await createTestStorage(10)
		const ino = await backend.create(backend.rootIno, 'note.txt', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})
		await backend.setMeta(ino, { mode: 0o600 })

		const result = await backend.scan?.('')

		expect(result?.next).toBe('')
		expect(result?.cursor).toBe('3')
		expect(result?.entries).toEqual([
			expect.objectContaining({
				ino,
				dirIno: backend.rootIno,
				name: 'note.txt',
			}),
		])
	})
})

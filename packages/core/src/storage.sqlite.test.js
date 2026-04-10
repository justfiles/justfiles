// @ts-ignore Bun resolves this at runtime; TypeScript in this workspace does not.
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { FsCursorExpiredError } from '@justfiles/fs/storage'
import { FileType } from '@justfiles/fs/types'
import { volume } from '@justfiles/fs'
import { createFsApi } from './fs'
import { createSqliteAdapter } from './db.sqlite'
import { parseSqlStatements } from './migrations/utils'
import { storage as sqliteStorage } from './storage.sqlite'

async function createTestStorage(maxRetainedUpdates) {
	const db = new Database(':memory:')
	const adapter = createSqliteAdapter(db)
	for (const file of ['0001_schema.sql']) {
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
			mtimeNs: 0n,
			ctimeNs: 0n,
			contentHash: undefined,
			symlinkTarget: undefined,
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
		}))
	})

	test('throws FsCursorExpiredError when the requested cursor has been pruned', async () => {
		const backend = await createTestStorage(2)
		const ino = await backend.caps.atomicCreate(backend.rootIno, 'note.txt', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})
		await backend.setMeta(ino, { mode: 0o600 })
		await backend.setMeta(ino, { mode: 0o644 })

		await expect(backend.caps.deltaUpdates('1')).rejects.toBeInstanceOf(FsCursorExpiredError)
		await expect(backend.caps.deltaUpdates('2')).resolves.toEqual({
			ops: [
				expect.objectContaining({ kind: 'upsert-inode', ino }),
				expect.objectContaining({ kind: 'upsert-inode', ino }),
			],
			cursor: '4',
		})
	})

	test('returns cursor_expired from the fs API when the backend cursor has been pruned', async () => {
		const backend = await createTestStorage(2)
		const ino = await backend.caps.atomicCreate(backend.rootIno, 'note.txt', {
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
		const ino = await backend.caps.atomicCreate(backend.rootIno, 'note.txt', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})
		await backend.setMeta(ino, { mode: 0o600 })

		const result = await backend.caps.fullScan?.('')

		expect(result?.next).toBe('')
		expect(result?.syncCursor).toBe('3')
		expect(result?.entries).toEqual([
			expect.objectContaining({
				ino,
				dirIno: backend.rootIno,
				name: 'note.txt',
			}),
		])
	})

	test('file endpoint reads file contents from a direct fs app', async () => {
		const backend = await createTestStorage(10)
		const vol = volume(backend)
		const enc = new TextEncoder()

		await vol.mkdir('/inbox')
		await vol.writeFile('/inbox/note.md', enc.encode('hello world'))

		const app = createFsApi(backend)
		const response = await app.request('/file/inbox/note.md')

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('hello world')
	})

	test('file endpoint reads file contents when mounted under /fs', async () => {
		const backend = await createTestStorage(10)
		const vol = volume(backend)
		const enc = new TextEncoder()

		await vol.mkdir('/inbox')
		await vol.writeFile('/inbox/note.md', enc.encode('mounted read'))

		const app = new Hono().route('/fs', createFsApi(backend))
		const response = await app.request('/fs/file/inbox/note.md')

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('mounted read')
	})
})

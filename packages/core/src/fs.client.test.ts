import type {
	FsOp,
	InodeMeta,
	MutationOptions,
	Storage,
	UpdateQueryOptions
} from '@justfiles/fs/storage'
import { FileType } from '@justfiles/fs/types'
import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'
import { createFsApi } from './fs'
import { apiStorage, createFsClient } from './fs.client'

function meta(type: FileType = FileType.Regular): InodeMeta {
	return { type, size: 0n, mode: 0o644, mtimeNs: 0n, ctimeNs: 0n }
}

function filterBySource(ops: FsOp[], options?: UpdateQueryOptions): FsOp[] {
	if (!options?.source) return ops
	return ops.filter((op) =>
		options.sourceMode === 'exclude' ? op.source !== options.source : op.source === options.source
	)
}

function recordingStorage(): Storage {
	const updates: FsOp[] = []
	const metas = new Map<string, InodeMeta>()
	metas.set('1', meta(FileType.Directory))

	function record(op: FsOp, options?: MutationOptions) {
		updates.push(options?.source ? { ...op, source: options.source } : op)
	}

	return {
		rootIno: '1',
		async getMeta(ino) {
			return metas.get(ino) ?? null
		},
		async setMeta(ino, partial, options) {
			metas.set(ino, { ...(metas.get(ino) ?? meta(partial.type)), ...partial })
			record({ kind: 'upsert-inode', ino, meta: partial }, options)
		},
		async deleteInode() {},
		async getBlob() {
			return new Uint8Array()
		},
		async putBlob(ino, data, options) {
			const next = { ...(metas.get(ino) ?? meta()), size: BigInt(data.length) }
			metas.set(ino, next)
			record({ kind: 'upsert-inode', ino, meta: next }, options)
		},
		async getDirent() {
			return null
		},
		async putDirent(dirIno, name, entry, options) {
			record({ kind: 'set-dirent', dirIno, name, ino: entry.ino, type: entry.type }, options)
		},
		async deleteDirent(dirIno, name, options) {
			record({ kind: 'unset-dirent', dirIno, name }, options)
		},
		async listDirents() {
			return { entries: [], next: '' }
		},
		caps: {
			async deltaUpdates(_cursor, options) {
				return { ops: filterBySource(updates, options), cursor: String(updates.length) }
			}
		}
	}
}

describe('apiStorage batch sync', () => {
	test('tags batched writes with source so a later pull skips own updates', async () => {
		const backend = recordingStorage()
		const app = new Hono().route('/fs', createFsApi(backend))
		const seenHeaders: Headers[] = []
		const client = createFsClient({
			baseUrl: 'http://local/fs',
			headers: async () => ({ Authorization: 'Bearer token' }),
			async fetch(input, init) {
				const request = input instanceof Request ? input : new Request(input, init)
				seenHeaders.push(request.headers)
				return app.request(request)
			}
		})
		const remote = await apiStorage(client)

		await remote.caps?.applyBatch?.(
			[
				{ kind: 'upsert-inode', ino: '2', meta: meta() },
				{ kind: 'set-dirent', dirIno: '1', name: 'note.txt', ino: '2', type: FileType.Regular }
			],
			async () => new Uint8Array([1, 2, 3]),
			{ source: 'client-1' }
		)

		await expect(
			remote.caps?.deltaUpdates?.('', { source: 'client-1', sourceMode: 'exclude' })
		).resolves.toEqual({ ops: [], cursor: '3' })
		expect(seenHeaders.at(-1)?.get('authorization')).toBe('Bearer token')
		expect(seenHeaders.at(-1)?.get('x-fs-source')).toBe('client-1')
	})
})

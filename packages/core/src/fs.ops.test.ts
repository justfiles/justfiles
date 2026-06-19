import type { InodeMeta, MutationOptions, Storage } from '@justfiles/fs/storage'
import { FileType } from '@justfiles/fs/types'
import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'
import { apiStorage, createFsClient } from './fs.client.ts'
import { createFsApi } from './fs.ts'

function meta(type: FileType = FileType.Regular): InodeMeta {
	return { type, size: 0n, mode: 0o644, mtimeNs: 0n, ctimeNs: 0n }
}

// A minimal backend that enforces the same dirent invariant sqliteStorage does:
// `putDirent` throws `ENOENT: <ino>` when its target inode is absent (the real
// `ensureDirentTarget` check). That's what makes a dangling set-dirent 500 the
// whole `/ops` batch — and what the handler's self-heal must now avoid.
function fkStorage(): Storage {
	const metas = new Map<string, InodeMeta>([['1', meta(FileType.Directory)]])
	const dirents = new Map<string, { ino: string; type: FileType }>()
	const key = (dirIno: string, name: string) => `${dirIno}/${name}`
	return {
		rootIno: '1',
		async getMeta(ino) {
			return metas.get(ino) ?? null
		},
		async setMeta(ino, partial) {
			metas.set(ino, { ...(metas.get(ino) ?? meta(partial.type)), ...partial })
		},
		async deleteInode(ino) {
			metas.delete(ino)
		},
		async getBlob() {
			return new Uint8Array()
		},
		async putBlob() {},
		async getDirent(dirIno, name) {
			return dirents.get(key(dirIno, name)) ?? null
		},
		async putDirent(dirIno, name, entry) {
			if (!metas.has(entry.ino)) throw new Error(`ENOENT: ${entry.ino}`)
			dirents.set(key(dirIno, name), entry)
		},
		async deleteDirent(dirIno, name) {
			dirents.delete(key(dirIno, name))
		},
		async listDirents() {
			return { entries: [], next: '' }
		}
	}
}

async function makeRemote(): Promise<{ remote: Storage; backend: Storage }> {
	const backend = fkStorage()
	const app = new Hono().route('/fs', createFsApi(backend))
	const client = createFsClient({
		baseUrl: 'http://local/fs',
		headers: async () => ({ Authorization: 'Bearer t' }),
		async fetch(input, init) {
			const request = input instanceof Request ? input : new Request(input, init)
			return app.request(request)
		}
	})
	return { remote: await apiStorage(client), backend }
}

const opts: MutationOptions = { source: 'c1' }
const noBlob = async () => new Uint8Array()

describe('/ops set-dirent self-heal', () => {
	test('a well-ordered create still applies', async () => {
		const { remote, backend } = await makeRemote()
		// biome-ignore lint/style/noNonNullAssertion: apiStorage always provides applyBatch
		await remote.caps!.applyBatch!(
			[
				{ kind: 'upsert-inode', ino: 'x', meta: meta() },
				{ kind: 'set-dirent', dirIno: '1', name: 'a.txt', ino: 'x', type: FileType.Regular }
			],
			noBlob,
			opts
		)
		expect(await backend.getDirent('1', 'a.txt')).toEqual({ ino: 'x', type: FileType.Regular })
	})

	test('a dangling set-dirent is skipped, not thrown, and the rest of the batch applies', async () => {
		const { remote, backend } = await makeRemote()
		// 'missing' has no upsert-inode (the diverged-replica case). Without the
		// self-heal this whole batch 500s and wedges every future push.
		await expect(
			// biome-ignore lint/style/noNonNullAssertion: apiStorage always provides applyBatch
			remote.caps!.applyBatch!(
				[
					{ kind: 'set-dirent', dirIno: '1', name: 'bad', ino: 'missing', type: FileType.Regular },
					{ kind: 'upsert-inode', ino: 'y', meta: meta() },
					{ kind: 'set-dirent', dirIno: '1', name: 'good', ino: 'y', type: FileType.Regular }
				],
				noBlob,
				opts
			)
		).resolves.toBeUndefined()

		// The dangling entry was dropped; the valid one in the same batch landed.
		expect(await backend.getDirent('1', 'bad')).toBeNull()
		expect(await backend.getDirent('1', 'good')).toEqual({ ino: 'y', type: FileType.Regular })
	})
})

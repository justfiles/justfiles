import { hc, type InferResponseType } from 'hono/client'
import {
	FsCursorExpiredError,
	type InodeMeta,
	type MutationOptions,
	type Storage
} from '@justfiles/fs/storage'
import { FileType } from '@justfiles/fs/types'
import type { createFsApi } from './fs'

const FS_SOURCE_HEADER = 'x-fs-source'

export type FsApiType = ReturnType<typeof createFsApi>
export type FsClient = ReturnType<typeof hc<FsApiType>>
export type FsClientHeaders = Record<string, string>

export interface FsClientOptions {
	baseUrl?: string
	headers?: FsClientHeaders | (() => FsClientHeaders | Promise<FsClientHeaders>)
	fetch?: typeof fetch
}

type FsMetaResponse = InferResponseType<FsClient['inodes'][':ino']['$get'], 200>

function mutationInit(options?: MutationOptions): { headers: Record<string, string> } | undefined {
	return options?.source ? { headers: { [FS_SOURCE_HEADER]: options.source } } : undefined
}

function parseMeta(wire: FsMetaResponse): InodeMeta {
	const meta = wire as Record<string, unknown>
	return {
		type: Number(meta.type) as FileType,
		size: BigInt(String(meta.size)),
		mode: Number(meta.mode),
		mtimeNs: BigInt(String(meta.mtimeNs)),
		ctimeNs: BigInt(String(meta.ctimeNs)),
		contentHash: typeof meta.contentHash === 'string' ? meta.contentHash : undefined,
		symlinkTarget: typeof meta.symlinkTarget === 'string' ? meta.symlinkTarget : undefined,
	}
}

function parseMetaPatch(wire: unknown): Partial<InodeMeta> {
	const meta = wire as Record<string, unknown>
	const patch: Partial<InodeMeta> = {}

	if (meta.type !== undefined) patch.type = Number(meta.type) as FileType
	if (meta.size !== undefined) patch.size = BigInt(String(meta.size))
	if (meta.mode !== undefined) patch.mode = Number(meta.mode)
	if (meta.mtimeNs !== undefined) patch.mtimeNs = BigInt(String(meta.mtimeNs))
	if (meta.ctimeNs !== undefined) patch.ctimeNs = BigInt(String(meta.ctimeNs))
	if (typeof meta.contentHash === 'string') patch.contentHash = meta.contentHash
	if ('contentHash' in meta && meta.contentHash === null) patch.contentHash = undefined
	if (typeof meta.symlinkTarget === 'string') patch.symlinkTarget = meta.symlinkTarget
	if ('symlinkTarget' in meta && meta.symlinkTarget === null) patch.symlinkTarget = undefined

	return patch
}

function wireFromMeta(meta: InodeMeta) {
	return {
		...meta,
		size: meta.size.toString(),
		mtimeNs: meta.mtimeNs.toString(),
		ctimeNs: meta.ctimeNs.toString()
	}
}

function decodeBase64(b64: string): Uint8Array {
	const binary = atob(b64)
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	const body = new ArrayBuffer(data.byteLength)
	new Uint8Array(body).set(data)
	return body
}

export function createFsClient(options: FsClientOptions = {}): FsClient {
	return hc<FsApiType>(options.baseUrl ?? '', {
		headers: options.headers,
		fetch: options.fetch
	})
}

export async function apiStorage(client: FsClient): Promise<Storage> {
	const rootRes = await client.index.$get()
	if (!rootRes.ok) throw new Error(`apiStorage: failed to fetch root: ${rootRes.status}`)
	const { rootIno } = await rootRes.json()

	const backend: Storage = {
		rootIno,

		async getMeta(ino) {
			const res = await client.inodes[':ino'].$get({ param: { ino } })
			if (res.status === 404) return null
			if (!res.ok) throw new Error(`getMeta failed: ${res.status}`)
			return parseMeta(await res.json())
		},

		async setMeta(ino, partial, options) {
			const wire: Record<string, unknown> = { ...partial }
			if (partial.size !== undefined) wire.size = partial.size.toString()
			if (partial.mtimeNs !== undefined) wire.mtimeNs = partial.mtimeNs.toString()
			if (partial.ctimeNs !== undefined) wire.ctimeNs = partial.ctimeNs.toString()

			const res = await client.inodes[':ino'].$patch(
				{ param: { ino }, json: wire },
				mutationInit(options)
			)
			if (!res.ok) throw new Error(`setMeta failed: ${res.status}`)
		},

		async deleteInode(_ino) {
			// Server handles inode deletion atomically when deleting a dirent.
		},

		async getBlob(ino) {
			const res = await client.inodes[':ino'].blob.$get({ param: { ino } })
			if (!res.ok) throw new Error(`getBlob failed: ${res.status}`)
			return new Uint8Array(await res.arrayBuffer())
		},

		async putBlob(ino, data, options) {
			const res = await client.inodes[':ino'].blob.$put(
				{ param: { ino } },
				{
					headers: {
						'Content-Type': 'application/octet-stream',
						...(options?.source ? { [FS_SOURCE_HEADER]: options.source } : {})
					},
					init: { body: toArrayBuffer(data) }
				}
			)
			if (!res.ok) throw new Error(`putBlob failed: ${res.status}`)
		},

		async getDirent(dirIno, name) {
			const res = await client.inodes[':dirIno'].entries[':name'].$get({
				param: { dirIno, name }
			})
			if (res.status === 404) return null
			if (!res.ok) throw new Error(`getDirent failed: ${res.status}`)
			return await res.json()
		},

		async listDirents(dirIno, cursor) {
			const res = await client.inodes[':dirIno'].entries.$get({
				param: { dirIno },
				query: { cursor }
			})
			if (!res.ok) throw new Error(`listDirents failed: ${res.status}`)
			return await res.json()
		},

		async putDirent(dirIno, name, entry, options) {
			const res = await client.inodes[':dirIno'].entries[':name'].$put(
				{
					param: { dirIno, name },
					json: { ino: entry.ino, type: entry.type }
				},
				mutationInit(options)
			)
			if (!res.ok) throw new Error(`putDirent failed: ${res.status}`)
		},

		async deleteDirent(dirIno, name, options) {
			const res = await client.inodes[':dirIno'].entries[':name'].$delete(
				{ param: { dirIno, name } },
				mutationInit(options)
			)
			if (res.status === 404) return
			if (!res.ok) throw new Error(`deleteDirent failed: ${res.status}`)
		},

		caps: {
			async atomicCreate(dirIno, name, meta, options) {
				const res = await client.inodes.$post(
					{ json: { dirIno, name, meta: wireFromMeta(meta) } },
					mutationInit(options)
				)
				if (res.status === 409) throw new Error(`EEXIST: ${name}`)
				if (!res.ok) throw new Error(`atomicCreate failed: ${res.status}`)
				const data = await res.json()
				return data.ino
			},

			async atomicMove(oldDirIno, oldName, newDirIno, newName, options) {
				const res = await client.rename.$post(
					{ json: { oldDirIno, oldName, newDirIno, newName } },
					mutationInit(options)
				)
				if (res.status === 404) return null
				if (!res.ok) throw new Error(`atomicMove failed: ${res.status}`)
				const data = await res.json()
				return data.displaced
			},

			async getXattr(ino, name) {
				const res = await client.inodes[':ino'].xattrs[':name'].$get({
					param: { ino, name }
				})
				if (res.status === 404) return null
				if (!res.ok) throw new Error(`getXattr failed: ${res.status}`)
				const data = await res.json()
				return decodeBase64(data.value)
			},

			async setXattr(ino, name, value, options) {
				const b64 = btoa(String.fromCharCode(...value))
				const res = await client.inodes[':ino'].xattrs[':name'].$put(
					{ param: { ino, name }, json: { value: b64 } },
					mutationInit(options)
				)
				if (!res.ok) throw new Error(`setXattr failed: ${res.status}`)
			},

			async listXattrs(ino) {
				const res = await client.inodes[':ino'].xattrs.$get({ param: { ino } })
				if (!res.ok) throw new Error(`listXattrs failed: ${res.status}`)
				const data = await res.json()
				return data.names
			},

			async removeXattr(ino, name, options) {
				const res = await client.inodes[':ino'].xattrs[':name'].$delete(
					{ param: { ino, name } },
					mutationInit(options)
				)
				if (!res.ok) throw new Error(`removeXattr failed: ${res.status}`)
			},

			async fullScan(cursor) {
				const res = await client.scan.$get({ query: { cursor } })
				if (!res.ok) throw new Error(`fullScan failed: ${res.status}`)
				const data = await res.json()
				return {
					entries: data.entries.map((entry) => ({
						...entry,
						meta: parseMeta(entry.meta),
						xattrs: entry.xattrs
							? Object.fromEntries(
									Object.entries(entry.xattrs as Record<string, string>).map(([key, value]) => [
										key,
										decodeBase64(value)
									])
								)
							: undefined,
					})),
					next: data.next,
					syncCursor: typeof data.syncCursor === 'string' ? data.syncCursor : '',
				}
			},

			async deltaUpdates(cursor, options) {
				const requestInit = mutationInit(options)
				const res = await client.updates.$get(
					{ query: { cursor } },
					{
						...(requestInit ? { headers: requestInit.headers } : {}),
						init: {
							cache: 'no-store',
						},
					}
				)

				if (res.status === 501) return { ops: [], cursor }
				if (res.status === 409) {
					const data = await res.json().catch(() => null)
					if (data && typeof data === 'object' && 'code' in data && data.code === 'cursor_expired') {
						const message =
							typeof data.error === 'string' ? data.error : 'FS sync cursor expired'
						throw new FsCursorExpiredError(message)
					}
				}
				if (!res.ok) throw new Error(`deltaUpdates failed: ${res.status}`)

				const data = await res.json()
				return {
					ops: data.ops.map((op) => {
						if (op.kind !== 'upsert-inode') return op
						return {
							...op,
							meta: op.meta ? parseMetaPatch(op.meta) : undefined,
							xattrs: op.xattrs
								? Object.fromEntries(
										Object.entries(op.xattrs as Record<string, string | null>).map(([key, value]) => [
											key,
											value !== null ? decodeBase64(value) : null
										])
									)
								: undefined
						}
					}),
					cursor: data.cursor
				}
			}
		}
	}

	return backend
}

import {
	FsCursorExpiredError,
	type FsOp,
	type InodeMeta,
	type MutationOptions,
	type Storage
} from '@justfiles/fs/storage'
import type { SyncReplica } from '@justfiles/fs/sync-replica'
import { PathChange } from '@justfiles/fs/sync-wire'
import { FileType } from '@justfiles/fs/types'
import { hc, type InferResponseType } from 'hono/client'
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

export interface ApiStorageOptions {
	rootIno?: string
}

type FsMetaResponse = InferResponseType<FsClient['inodes'][':ino']['$get'], 200>

// Attach the sync `source` as a request header on the Hono request object
// (args[0].header) rather than via ClientRequestOptions (args[1].headers): the
// latter is an object that replaces the client-level `headers` function, which
// would drop the Authorization callback and 401 any Bearer-authed mutation. The
// cast back to T hides the extra `header` key from the route's input type while
// the client still sends it at runtime (same trick as putBlob below).
function withSource<T extends Record<string, unknown>>(req: T, options?: MutationOptions): T {
	return options?.source ? ({ ...req, header: { [FS_SOURCE_HEADER]: options.source } } as T) : req
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
		symlinkTarget: typeof meta.symlinkTarget === 'string' ? meta.symlinkTarget : undefined
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

function encodeBase64(data: Uint8Array): string {
	let binary = ''
	for (const byte of data) binary += String.fromCharCode(byte)
	return btoa(binary)
}

// Encode one op for the /ops batch wire: stringify meta bigints, base64 xattrs,
// and inline regular-file content fetched via getBlob. set-/unset-dirent ops are
// already JSON-safe and pass through unchanged.
async function encodeBatchOp(
	op: FsOp,
	getBlob: (ino: string) => Promise<Uint8Array>
): Promise<unknown> {
	if (op.kind !== 'upsert-inode') return op
	const meta = op.meta
		? (() => {
				const out: Record<string, unknown> = { ...op.meta }
				if (op.meta.size !== undefined) out.size = op.meta.size.toString()
				if (op.meta.mtimeNs !== undefined) out.mtimeNs = op.meta.mtimeNs.toString()
				if (op.meta.ctimeNs !== undefined) out.ctimeNs = op.meta.ctimeNs.toString()
				return out
			})()
		: undefined
	const xattrs = op.xattrs
		? Object.fromEntries(Object.entries(op.xattrs).map(([k, v]) => [k, v ? encodeBase64(v) : null]))
		: undefined
	const data = op.meta?.type === FileType.Regular ? encodeBase64(await getBlob(op.ino)) : undefined
	return { kind: op.kind, ino: op.ino, meta, xattrs, data }
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

export async function apiStorage(
	client: FsClient,
	options: ApiStorageOptions = {}
): Promise<Storage> {
	const rootIno = options.rootIno ?? '1'

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
				withSource({ param: { ino }, json: wire }, options)
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
			// Per-request `header` (singular, on args[0]) is merged with the
			// client-level `headers` function. Using args[1].headers instead
			// would deep-merge-replace that function (it's not an object), so
			// the client-level Authorization callback would be dropped — fine
			// when a session cookie is present, 401 without one.
			const res = await client.inodes[':ino'].blob.$put(
				{
					param: { ino },
					header: {
						'Content-Type': 'application/octet-stream',
						...(options?.source ? { [FS_SOURCE_HEADER]: options.source } : {})
					}
				} as Parameters<(typeof client.inodes)[':ino']['blob']['$put']>[0],
				{ init: { body: toArrayBuffer(data) } }
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
				withSource({ param: { dirIno, name }, json: { ino: entry.ino, type: entry.type } }, options)
			)
			if (!res.ok) throw new Error(`putDirent failed: ${res.status}`)
		},

		async deleteDirent(dirIno, name, options) {
			const res = await client.inodes[':dirIno'].entries[':name'].$delete(
				withSource({ param: { dirIno, name } }, options)
			)
			if (res.status === 404) return
			if (!res.ok) throw new Error(`deleteDirent failed: ${res.status}`)
		},

		caps: {
			async atomicCreate(dirIno, name, meta, options) {
				const res = await client.inodes.$post(
					withSource({ json: { dirIno, name, meta: wireFromMeta(meta) } }, options)
				)
				if (res.status === 409) throw new Error(`EEXIST: ${name}`)
				if (!res.ok) throw new Error(`atomicCreate failed: ${res.status}`)
				const data = await res.json()
				return data.ino
			},

			async atomicMove(oldDirIno, oldName, newDirIno, newName, options) {
				const res = await client.rename.$post(
					withSource({ json: { oldDirIno, oldName, newDirIno, newName } }, options)
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
					withSource({ param: { ino, name }, json: { value: b64 } }, options)
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
					withSource({ param: { ino, name } }, options)
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
							: undefined
					})),
					next: data.next,
					syncCursor: typeof data.syncCursor === 'string' ? data.syncCursor : ''
				}
			},

			async applyBatch(ops, getBlob, options) {
				const wire = await Promise.all(ops.map((op) => encodeBatchOp(op, getBlob)))
				const res = await client.ops.$post(
					withSource({ json: { ops: wire } }, options) as Parameters<typeof client.ops.$post>[0]
				)
				if (!res.ok) throw new Error(`applyBatch failed: ${res.status}`)
			},

			async deltaUpdates(cursor, options) {
				const res = await client.updates.$get(withSource({ query: { cursor } }, options), {
					init: { cache: 'no-store' }
				})

				if (res.status === 501) return { ops: [], cursor }
				if (res.status === 409) {
					const data = await res.json().catch(() => null)
					if (
						data &&
						typeof data === 'object' &&
						'code' in data &&
						data.code === 'cursor_expired'
					) {
						const message = typeof data.error === 'string' ? data.error : 'FS sync cursor expired'
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
										Object.entries(op.xattrs as Record<string, string | null>).map(
											([key, value]) => [key, value !== null ? decodeBase64(value) : null]
										)
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

// ── Remote path-sync adapter (HTTP client for the /fs path endpoints) ─────────
// The remote `SyncReplica`: the client active, server passive. Blob transfer is
// asymmetric — pull reads blobs from the server, push uploads first. `clientId`
// identifies this device once per request via SOURCE_HEADER; the server stamps
// it as the origin `source` on every applied change (never read from the body).

export interface RemoteSyncReplicaOptions {
	clientId: string
}

export function remoteSyncReplica(
	client: FsClient,
	options: RemoteSyncReplicaOptions
): SyncReplica {
	const { clientId } = options
	return {
		async pathDeltas(cursor, opts) {
			// Note: `excludeLocalSource` is a LOCAL push concept; the remote only
			// supports `excludeOrigin`.
			const res = await client.path.changes.$get(
				{
					query: {
						cursor,
						excludeOrigin: opts?.excludeOrigin,
						limit: opts?.limit !== undefined ? String(opts.limit) : undefined
					}
				},
				{ init: { cache: 'no-store' } }
			)
			if (!res.ok) throw new Error(`pathDeltas failed: ${res.status}`)
			const data = await res.json()
			return {
				changes: data.changes.map((c) => PathChange.parse(c)),
				to: data.to,
				done: data.done
			}
		},

		async pathScan(page, opts) {
			const res = await client.path.snapshot.$get({
				query: {
					page,
					limit: opts?.limit !== undefined ? String(opts.limit) : undefined
				}
			})
			if (!res.ok) throw new Error(`pathScan failed: ${res.status}`)
			const data = await res.json()
			return {
				changes: data.changes.map((c) => PathChange.parse(c)),
				next: data.next,
				syncCursor: data.syncCursor,
				done: data.done
			}
		},

		async applyPathChanges(changes, _getBlobByHash) {
			// Push: blobs are uploaded first (see synced()'s uploadBlobs), then the
			// tree changes POST. `_getBlobByHash` is unused here — the server
			// hydrates from its own store after the blob upload.
			const res = await client.path.changes.$post({
				json: { changes },
				header: { [FS_SOURCE_HEADER]: clientId }
			} as Parameters<typeof client.path.changes.$post>[0])
			if (!res.ok) throw new Error(`applyPathChanges failed: ${res.status}`)
		},

		async getBlobByHash(hash) {
			const res = await client.blob[':hash'].$get({ param: { hash } })
			if (!res.ok) throw new Error(`getBlobByHash failed: ${res.status}`)
			return new Uint8Array(await res.arrayBuffer())
		},

		async hasBlobByHash(hash) {
			const res = await client.blob[':hash'].$head({ param: { hash } })
			return res.ok
		},

		async putBlobByHash(hash, data) {
			const res = await client.blob[':hash'].$put(
				{
					param: { hash },
					header: {
						'Content-Type': 'application/octet-stream',
						[FS_SOURCE_HEADER]: clientId
					}
				} as Parameters<(typeof client.blob)[':hash']['$put']>[0],
				{ init: { body: toArrayBuffer(data) } }
			)
			if (!res.ok) throw new Error(`putBlobByHash failed: ${res.status}`)
		}
	}
}

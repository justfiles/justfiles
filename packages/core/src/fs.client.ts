import type { InodeMeta, MutationOptions, Storage } from '@justfiles/fs/storage'
import { GenerationStaleError, type SyncReplica } from '@justfiles/fs/sync-replica'
import { PathChange } from '@justfiles/fs/sync-wire'
import type { FileType } from '@justfiles/fs/types'
import { hc, type InferResponseType } from 'hono/client'
import type { createFsApi } from './fs'

const FS_SOURCE_HEADER = 'x-fs-source'
const FS_GENERATION_HEADER = 'x-fs-generation'

// Detect the server's push-fence rejection. A mutating write stamped with a stale
// `x-fs-generation` comes back `409 { error: 'generation_stale', generation }`;
// surface it as a typed error so `synced()` can client-reset (and other callers
// re-sync). 409 is also used for EEXIST/ENOTEMPTY, so match the body, not the
// status — cloned so the original response body stays readable by callers.
async function throwIfStale(res: {
	status: number
	clone(): { json(): Promise<unknown> }
}): Promise<void> {
	if (res.status !== 409) return
	const body = (await res
		.clone()
		.json()
		.catch(() => null)) as { error?: string; generation?: number } | null
	if (body?.error === 'generation_stale') throw new GenerationStaleError(body.generation)
}

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
	// The client's known volume lineage, stamped as `x-fs-generation` on every
	// mutating request so the server can fence a stale write (push fencing). Omitted
	// = unfenced (legacy) — the caller opts in when it tracks a generation.
	generation?: () => number | undefined
}

type FsMetaResponse = InferResponseType<FsClient['inodes'][':ino']['$get'], 200>

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

export async function apiStorage(
	client: FsClient,
	options: ApiStorageOptions = {}
): Promise<Storage> {
	const rootIno = options.rootIno ?? '1'

	// Attach the sync `source` and (when known) `x-fs-generation` as request headers
	// on the Hono request object (args[0].header) rather than via
	// ClientRequestOptions (args[1].headers): the latter is an object that replaces
	// the client-level `headers` function, which would drop the Authorization
	// callback and 401 any Bearer-authed mutation. The cast back to T hides the
	// extra `header` key from the route's input type while the client still sends it
	// at runtime (same trick as putBlob below).
	// Read at request time (method params shadow the outer `options`, so route it
	// through this closure defined at apiStorage scope).
	const currentGeneration = (): number | undefined => options.generation?.()
	const withHeaders = <T extends Record<string, unknown>>(req: T, mopts?: MutationOptions): T => {
		const header: Record<string, string> = {}
		if (mopts?.source) header[FS_SOURCE_HEADER] = mopts.source
		const gen = currentGeneration()
		if (gen !== undefined) header[FS_GENERATION_HEADER] = String(gen)
		return Object.keys(header).length > 0 ? ({ ...req, header } as T) : req
	}

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
				withHeaders({ param: { ino }, json: wire }, options)
			)
			await throwIfStale(res)
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
			const gen = currentGeneration()
			const res = await client.inodes[':ino'].blob.$put(
				{
					param: { ino },
					header: {
						'Content-Type': 'application/octet-stream',
						...(options?.source ? { [FS_SOURCE_HEADER]: options.source } : {}),
						...(gen !== undefined ? { [FS_GENERATION_HEADER]: String(gen) } : {})
					}
				} as Parameters<(typeof client.inodes)[':ino']['blob']['$put']>[0],
				{ init: { body: toArrayBuffer(data) } }
			)
			await throwIfStale(res)
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
				withHeaders(
					{ param: { dirIno, name }, json: { ino: entry.ino, type: entry.type } },
					options
				)
			)
			await throwIfStale(res)
			if (!res.ok) throw new Error(`putDirent failed: ${res.status}`)
		},

		async deleteDirent(dirIno, name, options) {
			const res = await client.inodes[':dirIno'].entries[':name'].$delete(
				withHeaders({ param: { dirIno, name } }, options)
			)
			await throwIfStale(res)
			if (res.status === 404) return
			if (!res.ok) throw new Error(`deleteDirent failed: ${res.status}`)
		},

		caps: {
			async atomicCreate(dirIno, name, meta, options) {
				const res = await client.inodes.$post(
					withHeaders({ json: { dirIno, name, meta: wireFromMeta(meta) } }, options)
				)
				await throwIfStale(res)
				if (res.status === 409) throw new Error(`EEXIST: ${name}`)
				if (!res.ok) throw new Error(`atomicCreate failed: ${res.status}`)
				const data = await res.json()
				return data.ino
			},

			async atomicMove(oldDirIno, oldName, newDirIno, newName, options) {
				const res = await client.rename.$post(
					withHeaders({ json: { oldDirIno, oldName, newDirIno, newName } }, options)
				)
				await throwIfStale(res)
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
					withHeaders({ param: { ino, name }, json: { value: b64 } }, options)
				)
				await throwIfStale(res)
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
					withHeaders({ param: { ino, name } }, options)
				)
				await throwIfStale(res)
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
					next: data.next
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
	// The volume lineage `synced()` last agreed with, stamped as `x-fs-generation`
	// on push so the server fences a stale write (a `409 generation_stale` surfaces
	// as `GenerationStaleError`, which `synced()` turns into a client reset).
	generation?: () => number | undefined
}

export function remoteSyncReplica(
	client: FsClient,
	options: RemoteSyncReplicaOptions
): SyncReplica {
	const { clientId, generation } = options
	return {
		async handshake() {
			// GET /fs — the volume-lineage probe. Returns the server's `generation`
			// (undefined on a server that has not opted in) plus the advisory `resetId`
			// ("a reset/republish is in progress"). `synced()` calls this once per cycle
			// to detect a server-side volume reset and to drive crash-resume.
			const res = await client.index.$get()
			if (!res.ok) throw new Error(`handshake failed: ${res.status}`)
			const data = await res.json()
			return { generation: data.generation, resetId: data.resetId }
		},

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
				done: data.done,
				generation: data.generation
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
				done: data.done,
				generation: data.generation
			}
		},

		async applyPathChanges(changes, _getBlobByHash) {
			// Push: blobs are uploaded first (see synced()'s uploadBlobs), then the
			// tree changes POST. `_getBlobByHash` is unused here — the server hydrates
			// from its own store after the blob upload. A "take mine" republish is just
			// an ordinary push at the new generation (no special header).
			const gen = generation?.()
			const res = await client.path.changes.$post({
				json: { changes },
				header: {
					[FS_SOURCE_HEADER]: clientId,
					...(gen !== undefined ? { [FS_GENERATION_HEADER]: String(gen) } : {})
				}
			} as Parameters<typeof client.path.changes.$post>[0])
			await throwIfStale(res)
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
			const gen = generation?.()
			const res = await client.blob[':hash'].$put(
				{
					param: { hash },
					header: {
						'Content-Type': 'application/octet-stream',
						[FS_SOURCE_HEADER]: clientId,
						...(gen !== undefined ? { [FS_GENERATION_HEADER]: String(gen) } : {})
					}
				} as Parameters<(typeof client.blob)[':hash']['$put']>[0],
				{ init: { body: toArrayBuffer(data) } }
			)
			await throwIfStale(res)
			if (!res.ok) throw new Error(`putBlobByHash failed: ${res.status}`)
		}
	}
}

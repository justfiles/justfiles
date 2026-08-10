import type { InodeMeta, MutationOptions, Storage } from '@justfiles/fs/storage'
import {
	GenerationStaleError,
	LineageStaleError,
	type SyncReplica
} from '@justfiles/fs/sync-replica'
import { PathChange } from '@justfiles/fs/sync-wire'
import type { FileType } from '@justfiles/fs/types'
import { hc, type InferResponseType } from 'hono/client'
import type { createFsApi } from './fs'

const FS_SOURCE_HEADER = 'x-fs-source'
const FS_GENERATION_HEADER = 'x-fs-generation'
// Identity fence: a mutating push carries the client's known volume lineage here so
// the server rejects a write aimed at a DIFFERENT volume that happens to share the
// same generation epoch (which `x-fs-generation` alone can't distinguish).
const FS_LINEAGE_HEADER = 'x-fs-lineage'

// Detect the server's push-fence rejection. A mutating write stamped with a stale
// `x-fs-generation` comes back `409 { error: 'generation_stale', generation }`, and a
// write aimed at a different volume at the same generation comes back `409 { error:
// 'lineage_stale', lineageId }`; surface each as a typed error so `synced()` can
// reconcile (generation reset vs. identity re-handshake). 409 is also used for
// EEXIST/ENOTEMPTY, so match the body, not the status — cloned so the original
// response body stays readable by callers.
async function throwIfStale(res: {
	status: number
	clone(): { json(): Promise<unknown> }
}): Promise<void> {
	if (res.status !== 409) return
	const body = (await res
		.clone()
		.json()
		.catch(() => null)) as { error?: string; generation?: number; lineageId?: string } | null
	if (body?.error === 'lineage_stale') throw new LineageStaleError(body.lineageId)
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

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(data))
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
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

	// Attach the sync `source` and (when known) `x-fs-generation` on the Hono
	// request object (args[0].header), NOT via ClientRequestOptions (args[1].headers)
	// — that would replace the client-level `headers` function and drop the
	// Authorization callback, 401ing any Bearer-authed mutation. The cast back to T
	// hides the extra `header` key from the route's input type (same trick as
	// putBlob below). `generation` is read at request time via this closure.
	const currentGeneration = (): number | undefined => options.generation?.()
	const withHeaders = <T extends Record<string, unknown>>(req: T, mopts?: MutationOptions): T => {
		const header: Record<string, string> = {}
		if (mopts?.source) header[FS_SOURCE_HEADER] = mopts.source
		const gen = currentGeneration()
		if (gen !== undefined) header[FS_GENERATION_HEADER] = String(gen)
		return Object.keys(header).length > 0 ? ({ ...req, header } as T) : req
	}

	// Does the SERVER's backend have a hash-addressed content store? NEGOTIATED, not
	// assumed: `PUT /blob/:hash` stores a blob no inode references yet, which a backend
	// without `caps.content` has nowhere to put — it rejects, and a create that assumed
	// otherwise would fail before ever reaching `/inodes`. Fetched once and memoised,
	// lazily, so an apiStorage that never creates a file pays nothing for the answer.
	let contentStore: Promise<boolean> | undefined
	const serverHasContentStore = (): Promise<boolean> => {
		contentStore ??= (async () => {
			const res = await client.index.$get()
			if (!res.ok) return false
			return (await res.json()).contentStore === true
		})()
		return contentStore
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
			// `content` (see @justfiles/fs's storage.ts) IS passed to this backend: it has
			// no `caps.content`, so the VFS hands over the bytes and this claim owes them
			// write-then-publish.
			//
			// Where the server can, that is done the same way a local hash-addressed store
			// does it — PUT the bytes under their hash first (the server verifies the hash
			// and stores them content-addressed), then claim the name carrying the
			// reference. Two round trips, but in the order that matters: the name cannot
			// exist until the bytes it names already do.
			//
			// Where it cannot — a server over a backend with no content store — there is no
			// atomic publish available over this wire at all, so it falls back to claiming
			// the name and filling it (exactly what the VFS used to do itself). The content
			// is never lost; the create is simply not atomic there, and a reader can catch
			// it mid-fill. Closing that needs a create route that CARRIES its bytes, which
			// is a wire change and its own issue — named here rather than left implied.
			async atomicCreate(dirIno, name, meta, content, options) {
				let claimed = meta
				let fill: Uint8Array | undefined
				if (content !== undefined) {
					if (await serverHasContentStore()) {
						const hash = await sha256Hex(content)
						const blob = await client.blob[':hash'].$put(
							withHeaders(
								{ param: { hash }, header: { 'Content-Type': 'application/octet-stream' } },
								options
							) as Parameters<(typeof client.blob)[':hash']['$put']>[0],
							{ init: { body: toArrayBuffer(content) } }
						)
						await throwIfStale(blob)
						if (!blob.ok) throw new Error(`atomicCreate content failed: ${blob.status}`)
						claimed = { ...meta, size: BigInt(content.length), contentHash: hash }
					} else {
						fill = content
					}
				}
				const res = await client.inodes.$post(
					withHeaders({ json: { dirIno, name, meta: wireFromMeta(claimed) } }, options)
				)
				await throwIfStale(res)
				if (res.status === 409) throw new Error(`EEXIST: ${name}`)
				if (!res.ok) throw new Error(`atomicCreate failed: ${res.status}`)
				const data = await res.json()
				if (fill !== undefined) await backend.putBlob(data.ino, fill, options)
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
	// The volume IDENTITY `synced()` last agreed with, stamped as `x-fs-lineage` on
	// push so the server rejects a write aimed at a different volume at the same
	// generation (see FS_LINEAGE_HEADER). Also surfaces as `GenerationStaleError`.
	lineageId?: () => string | undefined
}

export function remoteSyncReplica(
	client: FsClient,
	options: RemoteSyncReplicaOptions
): SyncReplica {
	const { clientId, generation, lineageId } = options
	return {
		async handshake() {
			// GET /fs — the volume-lineage probe. Returns the server's `generation`
			// (undefined on a server that has not opted in), the stable `lineageId` (volume
			// identity), plus the advisory `resetId` ("a reset/republish is in progress").
			// `synced()` calls this once per cycle to detect a different volume / reset.
			const res = await client.index.$get()
			if (!res.ok) throw new Error(`handshake failed: ${res.status}`)
			const data = await res.json()
			return { generation: data.generation, resetId: data.resetId, lineageId: data.lineageId }
		},

		async reset(body) {
			// POST /fs/reset — the lineage MUTATION (the handshake's write side).
			// `adopt-mine` CASes the server's epoch and returns the new one; `complete`
			// clears its advisory reset flag once our republish drained. Fence-exempt
			// server-side (it is registered ahead of the fence), so a stale client can
			// still reset. The destructive modes are answered by the host that owns this
			// URL, not by createFsApi's route: a server with no such host — and one with
			// no `complete` capability — answers 501.
			const res = await client.reset.$post({ json: body })
			await throwIfStale(res)
			if (!res.ok) throw new Error(`reset ${body.mode} failed: ${res.status}`)
			return { generation: (await res.json()).generation }
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
			const lineage = lineageId?.()
			const res = await client.path.changes.$post({
				json: { changes },
				header: {
					[FS_SOURCE_HEADER]: clientId,
					...(gen !== undefined ? { [FS_GENERATION_HEADER]: String(gen) } : {}),
					...(lineage !== undefined ? { [FS_LINEAGE_HEADER]: lineage } : {})
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

		async missingBlobHashes(hashes) {
			const res = await client.blobs.missing.$post({ json: { hashes } })
			if (!res.ok) throw new Error(`missingBlobHashes failed: ${res.status}`)
			return new Set((await res.json()).missing)
		},

		async putBlobByHash(hash, data) {
			const gen = generation?.()
			const lineage = lineageId?.()
			const res = await client.blob[':hash'].$put(
				{
					param: { hash },
					header: {
						'Content-Type': 'application/octet-stream',
						[FS_SOURCE_HEADER]: clientId,
						...(gen !== undefined ? { [FS_GENERATION_HEADER]: String(gen) } : {}),
						...(lineage !== undefined ? { [FS_LINEAGE_HEADER]: lineage } : {})
					}
				} as Parameters<(typeof client.blob)[':hash']['$put']>[0],
				{ init: { body: toArrayBuffer(data) } }
			)
			await throwIfStale(res)
			if (!res.ok) throw new Error(`putBlobByHash failed: ${res.status}`)
		}
	}
}

import { FsCursorExpiredError, type StorageBackend, type InodeMeta, type FsOp, type MutationOptions } from 'ghost-fs/storage'
import { FileType } from 'ghost-fs/types'
import type { Ino, Off, DirCursor } from 'ghost-fs/types'
import { GHOSTORE_XATTR, encodeXattr, decodeXattr } from 'ghost-fs/xattr'
import type { InferResponseType } from 'hono/client'
import type { ApiClient, FsClient } from './useApiClient'

// Minimal shape of a Memory object returned by the ghostore REST API
interface MemoryResponse {
	id: string
	raw_text: string
	path: string
	title: string | null
	source: string | null
	tags: string[]
	links: unknown[]
	created_at: string
	updated_at: string
}

interface ChangeRow {
	id: string
	title: string | null
	path: string
	updated_at: string
	active: number
	tags: string[]
}

export const ROOT_INO = '__root__'
const DIR_PREFIX = '__dir__'
const FS_SOURCE_HEADER = 'x-fs-source'

// ---- helpers ----------------------------------------------------------------

const enc = new TextEncoder()

function dirInoToPath(dirIno: Ino): string {
	if (dirIno === ROOT_INO) return ''
	if (dirIno.startsWith(DIR_PREFIX)) return dirIno.slice(DIR_PREFIX.length)
	throw new Error(`Not a directory ino: ${dirIno}`)
}

function pathToDirIno(path: string): Ino {
	if (path === '') return ROOT_INO
	return `${DIR_PREFIX}${path}`
}

function joinPath(dirPath: string, name: string): string {
	return dirPath === '' ? name : `${dirPath}/${name}`
}

function isSameOrDescendant(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`)
}

function rewritePathPrefix(path: string, from: string, to: string): string {
	if (path === from) return to
	if (!path.startsWith(`${from}/`)) return path
	return `${to}${path.slice(from.length)}`
}

function mutationInit(options?: MutationOptions): { headers: Record<string, string> } | undefined {
	return options?.source ? { headers: { [FS_SOURCE_HEADER]: options.source } } : undefined
}

function metaFromMemory(memory: MemoryResponse): InodeMeta {
	return {
		type: FileType.Regular,
		size: BigInt(enc.encode(memory.raw_text).length),
		mode: 0o644,
		nlink: 1,
		mtimeNs: BigInt(Date.parse(memory.updated_at)) * 1_000_000n,
		ctimeNs: BigInt(Date.parse(memory.created_at)) * 1_000_000n,
		contentHash: undefined
	}
}

const SYNTHETIC_DIR_META: InodeMeta = {
	type: FileType.Directory,
	size: 0n,
	mode: 0o755,
	nlink: 2,
	mtimeNs: 0n,
	ctimeNs: 0n
}

// Derive immediate children names from a flat list of memory paths, given a dirPath prefix.
// Returns a map of childName → { ino, type } for each immediate child.
function immediateChildren(
	memories: Array<{ id: string; path: string }>,
	dirPath: string
): Map<string, { ino: Ino; type: FileType }> {
	const result = new Map<string, { ino: Ino; type: FileType }>()
	const prefix = dirPath === '' ? '' : `${dirPath}/`

	for (const m of memories) {
		if (!m.path.startsWith(prefix)) continue
		const rest = m.path.slice(prefix.length)
		if (rest === '') continue
		const slash = rest.indexOf('/')
		if (slash === -1) {
			// direct child file
			if (!result.has(rest)) {
				result.set(rest, { ino: m.id, type: FileType.Regular })
			}
		} else {
			// sub-directory
			const childName = rest.slice(0, slash)
			const childPath = prefix + childName
			if (!result.has(childName)) {
				result.set(childName, { ino: pathToDirIno(childPath), type: FileType.Directory })
			}
		}
	}

	return result
}

// Fetch ALL list results for a given path_prefix, following next_cursor pages.
async function listAll(
	api: ApiClient,
	pathPrefix: string | undefined
): Promise<Array<{ id: string; path: string }>> {
	const results: Array<{ id: string; path: string }> = []
	let cursor: string | undefined = undefined

	for (;;) {
		const res = await api.v1.list.$post({
			json: {
				path_prefix: pathPrefix,
				limit: 200,
				cursor
			}
		})
		if (!res.ok) throw new Error(`list failed: ${res.status}`)
		const data = await res.json()
		for (const r of data.results) {
			results.push({ id: r.id, path: r.path })
		}
		if (!data.next_cursor) break
		cursor = data.next_cursor
	}

	return results
}

function pathToUpdateOps(memory: ChangeRow): FsOp[] {
	const ops: FsOp[] = []
	const parts = memory.path.split('/').filter(Boolean)
	let parentIno: Ino = ROOT_INO
	let currentDirPath = ''

	for (const part of parts.slice(0, -1)) {
		currentDirPath = currentDirPath ? `${currentDirPath}/${part}` : part
		const dirIno = pathToDirIno(currentDirPath)
		ops.push({
			kind: 'upsert-inode',
			ino: dirIno,
			meta: { ...SYNTHETIC_DIR_META }
		})
		ops.push({
			kind: 'set-dirent',
			dirIno: parentIno,
			name: part,
			ino: dirIno,
			type: FileType.Directory
		})
		parentIno = dirIno
	}

	ops.push({
		kind: 'upsert-inode',
		ino: memory.id,
		meta: {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			nlink: 1,
			mtimeNs: BigInt(Date.parse(memory.updated_at)) * 1_000_000n,
			ctimeNs: BigInt(Date.parse(memory.updated_at)) * 1_000_000n,
		},
		xattrs: {
			[GHOSTORE_XATTR.title]: memory.title != null ? encodeXattr(memory.title) : null,
			[GHOSTORE_XATTR.tags]: memory.tags.length > 0 ? encodeXattr(memory.tags) : null
		},
	})

	const leafName = parts[parts.length - 1]
	if (!leafName) return ops

	if (memory.active === 0) {
		ops.push({
			kind: 'unset-dirent',
			dirIno: parentIno,
			name: leafName,
			ino: memory.id
		})
		return ops
	}

	ops.push({
		kind: 'set-dirent',
		dirIno: parentIno,
		name: leafName,
		ino: memory.id,
		type: FileType.Regular
	})
	return ops
}

// ---- exported factory -------------------------------------------------------

export interface ApiStorageBackend extends StorageBackend {
	rootIno: string
}

type FsMetaResponse = InferResponseType<FsClient['inodes'][':ino']['$get'], 200>

export function _apiStorage(client: ApiClient): ApiStorageBackend {
	const api = client
	const memoryFetches = new Map<string, Promise<MemoryResponse | null>>()
	const listFetches = new Map<string, Promise<Array<{ id: string; path: string }>>>()

	async function fetchMemory(ino: Ino): Promise<MemoryResponse | null> {
		if (ino === ROOT_INO || ino.startsWith(DIR_PREFIX)) return null

		const key = String(ino)
		const existing = memoryFetches.get(key)
		if (existing) return existing

		const fetch = (async () => {
			const res = await api.v1.memory[':id'].$get({ param: { id: ino } })
			if (res.status === 404) return null
			if (!res.ok) throw new Error(`get memory failed: ${res.status}`)
			return (await res.json()) as MemoryResponse
		})()

		memoryFetches.set(key, fetch)
		try {
			return await fetch
		} finally {
			memoryFetches.delete(key)
		}
	}

	async function listAllDeduped(
		pathPrefix: string | undefined
	): Promise<Array<{ id: string; path: string }>> {
		const key = pathPrefix ?? ''
		const existing = listFetches.get(key)
		if (existing) return existing

		const fetch = listAll(api, pathPrefix)
		listFetches.set(key, fetch)
		try {
			return await fetch
		} finally {
			listFetches.delete(key)
		}
	}

	async function updatePath(id: string, path: string): Promise<void> {
		const res = await api.v1.update.$post({ json: { id, path } })
		if (!res.ok) throw new Error(`update path failed: ${res.status}`)
	}

	async function archiveMemory(id: string): Promise<void> {
		const res = await api.v1.memory[':id'].archive.$post({ param: { id } })
		if (!res.ok) throw new Error(`archive failed: ${res.status}`)
	}

	async function renameTree(oldPath: string, newPath: string): Promise<void> {
		if (newPath === oldPath || newPath.startsWith(`${oldPath}/`)) {
			throw new Error(`EINVAL: ${newPath}`)
		}

		const all = await listAllDeduped(undefined)
		const matches = all.filter((memory) => isSameOrDescendant(memory.path, oldPath))
		if (matches.length === 0) throw new Error(`ENOENT: ${oldPath}`)

		const matchIds = new Set(matches.map((memory) => memory.id))
		for (const memory of all) {
			if (matchIds.has(memory.id)) continue
			const rewritten = rewritePathPrefix(memory.path, oldPath, newPath)
			if (rewritten !== memory.path) {
				throw new Error(`EEXIST: ${newPath}`)
			}
		}

		for (const memory of matches) {
			await updatePath(memory.id, rewritePathPrefix(memory.path, oldPath, newPath))
		}
	}

	async function archiveTree(path: string): Promise<Array<{ ino: Ino; type: FileType }>> {
		const all = await listAllDeduped(undefined)
		const matches = all.filter((memory) => isSameOrDescendant(memory.path, path))
		if (matches.length === 0) return []
		for (const memory of matches) {
			await archiveMemory(memory.id)
		}
		return matches.map((memory) => ({ ino: memory.id, type: FileType.Regular }))
	}

	return {
		rootIno: ROOT_INO,

		// ------------------------------------------------------------------
		// 1. INODE LIFECYCLE
		// ------------------------------------------------------------------

		async alloc(meta) {
			if (meta.type !== FileType.Regular) {
				throw new Error('ApiStorageBackend: only Regular files can be alloc-ed via the API')
			}
			const res = await api.v1.write.$post({
				json: { content: '' }
			})
			if (!res.ok) throw new Error(`alloc failed: ${res.status}`)
			const data = await res.json()
			return data.id
		},

		// ------------------------------------------------------------------
		// 2. INODE METADATA
		// ------------------------------------------------------------------

		async getMeta(ino) {
			if (ino === ROOT_INO || ino.startsWith(DIR_PREFIX)) {
				return { ...SYNTHETIC_DIR_META }
			}
			const memory = await fetchMemory(ino)
			return memory ? metaFromMemory(memory) : null
		},

		async setMeta(_ino, _partial) {
			// mode/mtime changes have no API mapping — silently no-op
		},

		// ------------------------------------------------------------------
		// 2b. EXTENDED ATTRIBUTES
		// ------------------------------------------------------------------

		async getXattr(ino, name) {
			const memory = await fetchMemory(ino)
			if (!memory) return null
			switch (name) {
				case GHOSTORE_XATTR.title: return memory.title != null ? encodeXattr(memory.title) : null
				case GHOSTORE_XATTR.tags: return memory.tags.length > 0 ? encodeXattr(memory.tags) : null
				case GHOSTORE_XATTR.links: return memory.links.length > 0 ? encodeXattr(memory.links) : null
				case GHOSTORE_XATTR.source: return memory.source != null ? encodeXattr(memory.source) : null
				default: return null
			}
		},

		async setXattr(ino, name, value) {
			if (ino === ROOT_INO || ino.startsWith(DIR_PREFIX)) return
			type UpdateBody = { id: string; title?: string; tags?: string[]; source?: string }
			const body: UpdateBody = { id: ino }
			switch (name) {
				case GHOSTORE_XATTR.title: body.title = decodeXattr<string>(value); break
				case GHOSTORE_XATTR.tags: body.tags = decodeXattr<string[]>(value); break
				case GHOSTORE_XATTR.source: body.source = decodeXattr<string>(value); break
				case GHOSTORE_XATTR.links: return
				default: return
			}
			const res = await api.v1.update.$post({ json: body })
			if (!res.ok) throw new Error(`setXattr failed: ${res.status}`)
		},

		async listXattr(ino) {
			const memory = await fetchMemory(ino)
			if (!memory) return []
			const names: string[] = []
			if (memory.title != null) names.push(GHOSTORE_XATTR.title)
			if (memory.tags.length > 0) names.push(GHOSTORE_XATTR.tags)
			if (memory.links.length > 0) names.push(GHOSTORE_XATTR.links)
			if (memory.source != null) names.push(GHOSTORE_XATTR.source)
			return names
		},

		// ------------------------------------------------------------------
		// 3. DATA I/O
		// ------------------------------------------------------------------

		async read(ino, offset: Off, length) {
			const memory = await fetchMemory(ino)
			if (!memory) return new Uint8Array(0)
			const bytes = enc.encode(memory.raw_text)
			const start = Number(offset)
			return bytes.subarray(start, start + length)
		},

		async write(_ino, _offset: Off, _data) {
			throw new Error('ApiStorageBackend: partial write not supported — use putBlob')
		},

		async truncate(ino, size: Off) {
			if (size !== 0n) {
				throw new Error('ApiStorageBackend: only size-0 truncate is supported')
			}
			const res = await api.v1.update.$post({ json: { id: ino, content: '' } })
			if (!res.ok) throw new Error(`truncate failed: ${res.status}`)
		},

		async putBlob(ino, data) {
			const content = new TextDecoder().decode(data)
			const res = await api.v1.update.$post({ json: { id: ino, content } })
			if (!res.ok) throw new Error(`putBlob failed: ${res.status}`)
		},

		// ------------------------------------------------------------------
		// 4. DIRECTORY ENTRIES
		// ------------------------------------------------------------------

		async dirLookup(dirIno, name) {
			const dirPath = dirInoToPath(dirIno)
			const all = await listAllDeduped(dirPath === '' ? undefined : dirPath)
			const children = immediateChildren(all, dirPath)
			const child = children.get(name)
			return child ?? null
		},

		async dirList(dirIno, cursor: DirCursor) {
			// We return everything in one shot (cursor is always "" → done)
			if (cursor !== '') return { entries: [], next: '' as DirCursor }

			const dirPath = dirInoToPath(dirIno)
			const all = await listAllDeduped(dirPath === '' ? undefined : dirPath)
			const children = immediateChildren(all, dirPath)

			const entries = [...children.entries()].map(([name, { ino, type }]) => ({
				name,
				ino,
				type
			}))

			return { entries, next: '' as DirCursor }
		},

		async dirAdd(dirIno, name, ino, type) {
			// No-clobber insert: update the memory's path only if nothing already lives there.
			const dirPath = dirInoToPath(dirIno)
			if (type !== FileType.Regular) return true // virtual dirs need no storage
			const newPath = joinPath(dirPath, name)

			// Check for an existing memory at the target path (no-clobber contract).
			const existing = await listAllDeduped(dirPath === '' ? undefined : dirPath)
			if (existing.some((m) => m.path === newPath)) return false

			const res = await api.v1.update.$post({ json: { id: ino, path: newPath } })
			if (!res.ok) throw new Error(`dirAdd failed: ${res.status}`)
			return true
		},

		async dirSet(dirIno, name, ino, type) {
			// Unconditional replace: archive any displaced entry, then move ino to the new path.
			const dirPath = dirInoToPath(dirIno)
			if (type !== FileType.Regular) return null
			const newPath = joinPath(dirPath, name)

			// Detect displaced entry (a different memory already at newPath).
			const existing = await listAllDeduped(dirPath === '' ? undefined : dirPath)
			const displaced = existing.find((m) => m.path === newPath && m.id !== ino) ?? null

			if (displaced) {
				const ar = await api.v1.memory[':id'].archive.$post({ param: { id: displaced.id } })
				if (!ar.ok) throw new Error(`dirSet archive displaced failed: ${ar.status}`)
			}

			const res = await api.v1.update.$post({ json: { id: ino, path: newPath } })
			if (!res.ok) throw new Error(`dirSet failed: ${res.status}`)
			return displaced ? { ino: displaced.id, type: FileType.Regular } : null
		},

		// Atomic rename — avoids the VFS two-step (dirSet + dirUnset) where the path
		// rewrite in dirSet makes the subsequent dirUnset unable to find the old entry.
		async rename(oldDirIno, oldName, newDirIno, newName) {
			const oldDirPath = dirInoToPath(oldDirIno)
			const newDirPath = dirInoToPath(newDirIno)
			const oldPath = joinPath(oldDirPath, oldName)
			const newPath = joinPath(newDirPath, newName)

			const all = await listAllDeduped(undefined)
			const src = all.find((m) => m.path === oldPath)
			if (!src) {
				await renameTree(oldPath, newPath)
				return null
			}

			const displaced = all.find((m) => m.path === newPath && m.id !== src.id) ?? null

			// NOTE: the two calls below are NOT atomic. If the archive succeeds but the
			// path update fails, the displaced memory is gone and the source has not moved —
			// a consistency window that cannot be closed without a server-side rename
			// transaction. This is still strictly better than the VFS two-step fallback,
			// which could leave two memories at the destination path.
			if (displaced) {
				await archiveMemory(displaced.id)
			}

			await updatePath(src.id, newPath)
			return displaced ? displaced.id : null
		},

		async dirUnset(dirIno, name) {
			// To "remove" a file from a directory means archiving the memory.
			// First look it up to get its ino.
			const dirPath = dirInoToPath(dirIno)
			const targetPath = joinPath(dirPath, name)
			const all = await listAllDeduped(dirPath === '' ? undefined : dirPath)
			const match = all.find((m) => m.path === targetPath)
			if (match) {
				await archiveMemory(match.id)
				return { ino: match.id, type: FileType.Regular }
			}

			const removed = await archiveTree(targetPath)
			return removed[0] ?? null
		},

		// ------------------------------------------------------------------
		// Optional: updates — delta sync support
		// ------------------------------------------------------------------

		async updates(cursor: string) {
			const res = await api.v1.changes.$get(
				{ query: { since: cursor } },
				{ init: { cache: 'no-store' } }
			)
			// On error keep the cursor unchanged — next attempt re-fetches the
			// same window so no changes are lost.
			if (!res.ok) return { ops: [], cursor }
			const data = await res.json()
			const ops = data.upserted.flatMap((memory: ChangeRow) => pathToUpdateOps(memory))
			const nextCursor = typeof data.cursor === 'string' ? data.cursor : cursor
			return { ops, cursor: nextCursor }
		},

		// ------------------------------------------------------------------
		// Optional: scan (parent-before-child order)
		// ------------------------------------------------------------------

		async scan(_cursor: string) {
			const all = await listAllDeduped(undefined)
			// Build full list — directories first, then files, in path order
			const dirsSeen = new Set<string>()
			const entries: Array<{ ino: Ino; dirIno: Ino; name: string; meta: InodeMeta }> = []

			// Collect all directory paths in order (parent-before-child)
			for (const m of all) {
				const segments = m.path.split('/')
				// Ensure all ancestor directories are emitted first
				for (let depth = 1; depth < segments.length; depth++) {
					const dirPath = segments.slice(0, depth).join('/')
					if (!dirsSeen.has(dirPath)) {
						dirsSeen.add(dirPath)
						const parentDepth = depth - 1
						const parentPath = parentDepth === 0 ? '' : segments.slice(0, parentDepth).join('/')
						const dName = segments[depth - 1]!
						entries.push({
							ino: pathToDirIno(dirPath),
							dirIno: parentPath === '' ? ROOT_INO : pathToDirIno(parentPath),
							name: dName,
							meta: { ...SYNTHETIC_DIR_META }
						})
					}
				}
			}

			// Then emit all files
			for (const m of all) {
				const slash = m.path.lastIndexOf('/')
				const parentPath = slash === -1 ? '' : m.path.slice(0, slash)
				const name = slash === -1 ? m.path : m.path.slice(slash + 1)
				entries.push({
					ino: m.id,
					dirIno: parentPath === '' ? ROOT_INO : pathToDirIno(parentPath),
					name,
					meta: {
						type: FileType.Regular,
						size: 0n, // size unknown without fetching raw_text
						mode: 0o644,
						nlink: 1,
						mtimeNs: 0n,
						ctimeNs: 0n
					}
				})
			}

			return { entries, next: '' }
		}
	}
}

// ── Wire-format helpers (inverse of createFsApi's encoders) ──────────────────

function parseMeta(wire: FsMetaResponse): InodeMeta {
	const meta = wire as Record<string, unknown>
	return {
		type: Number(meta.type) as FileType,
		size: BigInt(String(meta.size)),
		mode: Number(meta.mode),
		nlink: Number(meta.nlink),
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
	if (meta.nlink !== undefined) patch.nlink = Number(meta.nlink)
	if (meta.mtimeNs !== undefined) patch.mtimeNs = BigInt(String(meta.mtimeNs))
	if (meta.ctimeNs !== undefined) patch.ctimeNs = BigInt(String(meta.ctimeNs))
	if (typeof meta.contentHash === 'string') patch.contentHash = meta.contentHash
	if ('contentHash' in meta && meta.contentHash === null) patch.contentHash = undefined
	if (typeof meta.symlinkTarget === 'string') patch.symlinkTarget = meta.symlinkTarget
	if ('symlinkTarget' in meta && meta.symlinkTarget === null) patch.symlinkTarget = undefined

	return patch
}

function wireFromMeta(meta: Omit<InodeMeta, 'nlink'>) {
	return {
		...meta,
		size: meta.size.toString(),
		mtimeNs: meta.mtimeNs.toString(),
		ctimeNs: meta.ctimeNs.toString()
	}
}

function decodeBase64(b64: string): Uint8Array {
	const binary = atob(b64)
	const arr = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i)
	return arr
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	const body = new ArrayBuffer(data.byteLength)
	new Uint8Array(body).set(data)
	return body
}

/**
 * StorageBackend backed by the remote /fs REST API (createFsApi).
 *
 * Async factory: pre-fetches rootIno via GET / so the sync rootIno property
 * is available immediately on the returned backend.
 */
export async function apiStorage(client: FsClient): Promise<StorageBackend> {
	const c = client

	const rootRes = await c.$get()
	if (!rootRes.ok) throw new Error(`apiStorage: failed to fetch root: ${rootRes.status}`)
	const { rootIno } = await rootRes.json()

	const backend: StorageBackend = {
		rootIno,

		// ── Inode lifecycle ────────────────────────────────────────────────

		async alloc(_meta, _options) {
			// VFS prefers create() over alloc()+dirAdd() — this path is unreachable
			// when create() is implemented. Kept to satisfy the interface.
			throw new Error('apiStorage: alloc() not supported — use create()')
		},

		async create(dirIno, name, meta, options) {
			const res = await c.inodes.$post({ json: { dirIno, name, meta: wireFromMeta(meta) } }, mutationInit(options))
			if (res.status === 409) throw new Error(`EEXIST: ${name}`)
			if (!res.ok) throw new Error(`create failed: ${res.status}`)
			const data = await res.json()
			return data.ino
		},

		// ── Inode metadata ─────────────────────────────────────────────────

		async getMeta(ino) {
			const res = await c.inodes[':ino'].$get({ param: { ino } })
			if (res.status === 404) return null
			if (!res.ok) throw new Error(`getMeta failed: ${res.status}`)
			return parseMeta(await res.json())
		},

		async setMeta(ino, partial, options) {
			const wire: Record<string, unknown> = { ...partial }
			if (partial.size !== undefined) wire.size = partial.size.toString()
			if (partial.nlink !== undefined) wire.nlink = partial.nlink
			if (partial.mtimeNs !== undefined) wire.mtimeNs = partial.mtimeNs.toString()
			if (partial.ctimeNs !== undefined) wire.ctimeNs = partial.ctimeNs.toString()
			const res = await c.inodes[':ino'].$patch({ param: { ino }, json: wire }, mutationInit(options))
			if (!res.ok) throw new Error(`setMeta failed: ${res.status}`)
		},

		// ── Data I/O ───────────────────────────────────────────────────────

		async read(ino, offset, length) {
			const res = await c.inodes[':ino'].blob.$get({ param: { ino } })
			if (!res.ok) throw new Error(`read failed: ${res.status}`)
			const full = new Uint8Array(await res.arrayBuffer())
			const start = Number(offset)
			return full.subarray(start, start + length)
		},

		async write(ino, offset, data, options) {
			// Read-modify-write fallback. Sync layer should call putBlob() instead.
			const res = await c.inodes[':ino'].blob.$get({ param: { ino } })
			if (!res.ok) throw new Error(`write failed: ${res.status}`)
			const full = new Uint8Array(await res.arrayBuffer())
			const start = Number(offset)
			const newSize = Math.max(full.length, start + data.length)
			const buf = new Uint8Array(newSize)
			buf.set(full)
			buf.set(data, start)
			await backend.putBlob!(ino, buf, options)
			return data.length
		},

		async truncate(ino, size, options) {
			if (size === 0n) {
				await backend.putBlob!(ino, new Uint8Array(0), options)
			} else {
				const res = await c.inodes[':ino'].blob.$get({ param: { ino } })
				if (!res.ok) throw new Error(`truncate failed: ${res.status}`)
				const full = new Uint8Array(await res.arrayBuffer())
				await backend.putBlob!(ino, full.subarray(0, Number(size)), options)
			}
		},

		async putBlob(ino, data, options) {
			const res = await c.inodes[':ino'].blob.$put(
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

		// ── Directory entries ──────────────────────────────────────────────

		async dirLookup(dirIno, name) {
			const res = await c.inodes[':dirIno'].entries[':name'].$get({ param: { dirIno, name } })
			if (res.status === 404) return null
			if (!res.ok) throw new Error(`dirLookup failed: ${res.status}`)
			const data = await res.json()
			return data
		},

		async dirList(dirIno, cursor) {
			const res = await c.inodes[':dirIno'].entries.$get({ param: { dirIno }, query: { cursor } })
			if (!res.ok) throw new Error(`dirList failed: ${res.status}`)
			const data = await res.json()
			return data
		},

		async dirAdd(dirIno, name, ino, type, options) {
			// No-clobber: check first (not atomic, acceptable for remote backend).
			const existing = await backend.dirLookup(dirIno, name)
			if (existing !== null) return false
			const res = await c.inodes[':dirIno'].entries[':name'].$put({
				param: { dirIno, name },
				json: { ino, type }
			}, mutationInit(options))
			if (!res.ok) throw new Error(`dirAdd failed: ${res.status}`)
			return true
		},

		async dirSet(dirIno, name, ino, type, options) {
			const res = await c.inodes[':dirIno'].entries[':name'].$put({
				param: { dirIno, name },
				json: { ino, type }
			}, mutationInit(options))
			if (!res.ok) throw new Error(`dirSet failed: ${res.status}`)
			const data = await res.json()
			return data.displaced
		},

		async dirUnset(dirIno, name, options) {
			const res = await c.inodes[':dirIno'].entries[':name'].$delete({ param: { dirIno, name } }, mutationInit(options))
			if (res.status === 404) return null
			if (!res.ok) throw new Error(`dirUnset failed: ${res.status}`)
			const data = await res.json()
			return data.removed
		},

		async rename(oldDirIno, oldName, newDirIno, newName, options) {
			const res = await c.rename.$post({ json: { oldDirIno, oldName, newDirIno, newName } }, mutationInit(options))
			if (res.status === 404) return null
			if (!res.ok) throw new Error(`rename failed: ${res.status}`)
			const data = await res.json()
			return data.displaced
		},

		// ── Extended attributes ────────────────────────────────────────────

		async getXattr(ino, name) {
			const res = await c.inodes[':ino'].xattrs[':name'].$get({ param: { ino, name } })
			if (res.status === 404) return null
			if (!res.ok) throw new Error(`getXattr failed: ${res.status}`)
			const data = await res.json()
			return decodeBase64(data.value)
		},

		async setXattr(ino, name, value, options) {
			const b64 = btoa(String.fromCharCode(...value))
			const res = await c.inodes[':ino'].xattrs[':name'].$put(
				{ param: { ino, name }, json: { value: b64 } },
				mutationInit(options)
			)
			if (!res.ok) throw new Error(`setXattr failed: ${res.status}`)
		},

		async listXattr(ino) {
			const res = await c.inodes[':ino'].xattrs.$get({ param: { ino } })
			if (!res.ok) throw new Error(`listXattr failed: ${res.status}`)
			const data = await res.json()
			return data.names
		},

		async removeXattr(ino, name, options) {
			const res = await c.inodes[':ino'].xattrs[':name'].$delete(
				{ param: { ino, name } },
				mutationInit(options)
			)
			if (!res.ok) throw new Error(`removeXattr failed: ${res.status}`)
		},

		// ── Optional: scan & updates ───────────────────────────────────────

		async scan(cursor) {
			const res = await c.scan.$get({ query: { cursor } })
			if (!res.ok) throw new Error(`scan failed: ${res.status}`)
			const data = await res.json()
			return {
				entries: data.entries.map((entry) => ({
					...entry,
					meta: parseMeta(entry.meta),
					xattrs: entry.xattrs
						? Object.fromEntries(
							Object.entries(entry.xattrs as Record<string, string>).map(([k, v]) => [k, decodeBase64(v)])
						  )
						: undefined,
				})),
				next: data.next,
				cursor: typeof data.cursor === 'string' ? data.cursor : undefined,
			}
		},

		async updates(cursor, options) {
			const requestInit = mutationInit(options)
			const res = await c.updates.$get(
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
					const message = typeof data.error === 'string' ? data.error : 'FS sync cursor expired'
					throw new FsCursorExpiredError(message)
				}
			}
			if (!res.ok) throw new Error(`updates failed: ${res.status}`)
			const data = await res.json()
			return {
				ops: data.ops.map((op) => {
					if (op.kind !== 'upsert-inode') return op
					return {
						...op,
						meta: op.meta ? parseMetaPatch(op.meta) : undefined,
						xattrs: op.xattrs
							? Object.fromEntries(
									Object.entries(op.xattrs as Record<string, string | null>).map(([k, v]) => [
										k,
										v !== null ? decodeBase64(v) : null
									])
								)
							: undefined
					}
				}),
				cursor: data.cursor
			}
		}
	}

	return backend
}

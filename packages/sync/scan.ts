import { volume } from '@justfiles/fs'
import type { ContentStore, Storage } from '@justfiles/fs/storage'
import { FileType } from '@justfiles/fs/types'
import { hashBytes, verifyBytes } from './content'
import { syncIgnore } from './replica'
import { inodeMetaFromSync, type SyncMeta, syncMetaFromInode } from './wire'

export type FullScanEntry = {
	path: string
	meta: SyncMeta
	contentHash?: string
}

export type FullScanSnapshot = {
	entries: FullScanEntry[]
	getBlobByHash(hash: string): Promise<Uint8Array>
	close(): Promise<void>
}

export interface FullScanReplica {
	scan(): Promise<FullScanSnapshot>
	apply(
		entries: readonly FullScanEntry[],
		getBlobByHash: (hash: string) => Promise<Uint8Array>
	): Promise<void>
}

async function readTree(
	storage: Storage,
	addressed?: ContentStore
): Promise<{
	entries: FullScanEntry[]
	blobs: Map<string, Uint8Array>
}> {
	const fs = volume(storage)
	const ignored = syncIgnore()
	const entries: FullScanEntry[] = []
	const blobs = new Map<string, Uint8Array>()
	await fs.scan('/', async (path, stat) => {
		if (path === '/' || ignored(path)) return
		const inode = await storage.getMeta(stat.ino)
		if (!inode) return
		const xattrs: Record<string, Uint8Array> = {}
		for (const name of (await storage.caps?.listXattrs?.(stat.ino)) ?? []) {
			const value = await storage.caps?.getXattr?.(stat.ino, name)
			if (value) xattrs[name] = value
		}
		const entry: FullScanEntry = { path, meta: syncMetaFromInode(inode, xattrs) }
		if (inode.type === FileType.Regular) {
			const stored = inode.contentHash ? await addressed?.getByHash(inode.contentHash) : undefined
			const data = stored ?? (await storage.getBlob(stat.ino))
			const contentHash = inode.contentHash ?? (await hashBytes(data))
			await verifyBytes(contentHash, data)
			entry.contentHash = contentHash
			entry.meta.size = String(data.length)
			if (!blobs.has(contentHash)) blobs.set(contentHash, data.slice())
		}
		entries.push(entry)
	})
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
	return { entries, blobs }
}

function signature(entries: readonly FullScanEntry[]): string {
	return JSON.stringify(entries)
}

/** Full reconciliation for a backend that exposes only the filesystem contract. */
export function fullScanReplica(storage: Storage, addressed?: ContentStore): FullScanReplica {
	const fs = volume(storage)
	return {
		async scan() {
			let frozen: Awaited<ReturnType<typeof readTree>>
			for (;;) {
				frozen = await readTree(storage, addressed)
				const confirmed = await readTree(storage, addressed)
				if (signature(frozen.entries) === signature(confirmed.entries)) break
			}
			let open = true
			return {
				entries: frozen.entries,
				async getBlobByHash(hash) {
					if (!open) throw new Error('scan closed')
					const blob = frozen.blobs.get(hash)
					if (!blob) throw new Error(`ENOENT: scan blob ${hash}`)
					return blob.slice()
				},
				async close() {
					open = false
					frozen.blobs.clear()
				}
			}
		},
		async apply(entries, getBlobByHash) {
			const ignored = syncIgnore()
			const admissible = entries.filter((entry) => !ignored(entry.path))
			const current = await readTree(storage, addressed)
			const wanted = new Set(admissible.map((entry) => entry.path))
			for (const entry of [...current.entries].sort((a, b) => b.path.length - a.path.length))
				if (!wanted.has(entry.path)) await fs.rm(entry.path, { recursive: true, force: true })

			const byPath = new Map(current.entries.map((entry) => [entry.path, entry]))
			const blobs = new Map<string, Uint8Array>()
			async function blob(hash: string): Promise<Uint8Array> {
				const known = blobs.get(hash)
				if (known) return known
				const local = await addressed?.getByHash(hash)
				const data = await verifyBytes(hash, local ?? (await getBlobByHash(hash)))
				blobs.set(hash, data)
				if (!local) await addressed?.putByHash(hash, data)
				return data
			}

			for (const entry of admissible) {
				let existing = byPath.get(entry.path)
				if (existing && existing.meta.type !== entry.meta.type) {
					await fs.rm(entry.path, { recursive: true, force: true })
					existing = undefined
				}
				if (entry.meta.type === FileType.Directory) {
					if (!existing) await fs.mkdir(entry.path)
				} else if (entry.meta.type === FileType.Symlink) {
					if (!existing || existing.meta.symlinkTarget !== entry.meta.symlinkTarget) {
						if (existing) await fs.rm(entry.path, { force: true })
						await fs.symlink(entry.meta.symlinkTarget ?? '', entry.path)
					}
				} else if (!existing || existing.contentHash !== entry.contentHash) {
					if (!entry.contentHash) throw new Error(`missing content hash: ${entry.path}`)
					await fs.writeFile(entry.path, await blob(entry.contentHash))
				}

				if (entry.meta.type === FileType.Symlink) continue
				await fs.chmod(entry.path, entry.meta.mode)
				await fs.utimes(entry.path, BigInt(entry.meta.mtimeNs))
				const { xattrs } = inodeMetaFromSync(entry.meta)
				for (const name of await fs.listXattr(entry.path))
					if (!name.startsWith('trusted.') && xattrs[name] === undefined)
						await fs.removeXattr(entry.path, name)
				for (const [name, value] of Object.entries(xattrs))
					await fs.setXattr(entry.path, name, value)
			}
		}
	}
}

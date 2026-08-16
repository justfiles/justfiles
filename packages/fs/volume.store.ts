/**
 * The POSIX view over a `Store`. Design table A maps every operation to seam
 * calls, and this is that table as code: resolution is a `child` per segment,
 * `stat` is a row, `readdir` is a paged `children`, `readFile` is a row plus one
 * `blobs.get` — and every write is one guarded `commit`.
 *
 * There is no cache here. The old volume cached dirents and meta because a
 * segment cost it a `getDirent` and then a `getMeta`; here a segment IS one
 * `child`, and the row it hands back is already the stat. A cache would buy
 * back nothing per segment and owe invalidation on every write.
 *
 * There is no lock here either. The old volume held a per-inode write chain so a
 * read-modify-write could not be split; the seam does that with a version guard,
 * so a writer that loses reads again instead of waiting. Concurrency is settled
 * by the store, in one place, for every backend.
 *
 * T7 adds `watch` and T18 renames this to `volume`.
 */

import {
	type Cursor,
	type Guard,
	GuardError,
	type Hash,
	type Node,
	type NodeId,
	ROOT,
	type Store,
	sha256Hex,
	type Version
} from './store'
import { type Dirent, FileType, type Stat } from './types'
import type { Volume } from './volume'

/** Hops, not depth: what bounds a symlink cycle. Same limit as Linux. */
const MAX_SYMLINK_HOPS = 40

/**
 * How many times an operation replans before it gives up. A rejected guard means
 * another writer committed between this attempt's read and its write, so every
 * rejection is somebody else making progress — the cap is a livelock stop, not a
 * concurrency limit.
 */
const MAX_ATTEMPTS = 32

/** S_IFMT: the row carries a whole POSIX mode, `Stat` carries a `type`. */
const IFMT = 0o170000
const IFREG = 0o100000
const IFDIR = 0o040000
const IFLNK = 0o120000

const utf8 = new TextEncoder()

const TYPE: Record<Node['type'], FileType> = {
	file: FileType.Regular,
	dir: FileType.Directory,
	symlink: FileType.Symlink,
	// A junction stands where a directory would, so that is what it stats as.
	// T15 is what makes resolution continue through it into the bound store.
	mount: FileType.Directory
}

/** The row IS the stat. Nothing here is derived, and nothing touches content. */
const statOf = (node: Node): Stat => ({
	ino: node.id,
	type: TYPE[node.type],
	size: node.size,
	// The ROW holds a whole POSIX mode; `Stat` does not. `type` above carries the
	// kind, and the old volume reports permission bits here — the stores mint the
	// root as `0o040755`, and just-bash prints this number straight out of `stat`,
	// so an unmasked view would have agents reading `40755` for `/`.
	mode: node.mode & 0o7777,
	mtimeNs: node.mtimeNs,
	// The model has no ctime (design #2, deliberate omissions): report mtime.
	ctimeNs: node.mtimeNs,
	contentHash: node.content
})

const isDir = (node: Node): boolean => node.type === 'dir' || node.type === 'mount'

const join = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`)

/**
 * `local:<author>:<counter>` until [T8], where the engine mints author-tagged
 * versions and injects its own here. The author tag is not decoration even now:
 * two volumes over one store must never mint the same string, or a stale version
 * guard passes and a lost update goes unseen.
 */
function localVersions(): () => Version {
	const author = crypto.randomUUID().slice(0, 8)
	let n = 0
	return () => `local:${author}:${++n}`
}

/** T7. Declared so this is a whole `Volume` — `chroot` wraps one, not a half. */
const later = async (): Promise<never> => {
	throw new Error('ENOSYS: not implemented yet')
}

export function storeVolume(store: Store, opts?: { mintVersion?: () => Version }): Volume {
	const mint = opts?.mintVersion ?? localVersions()
	const now = (): bigint => BigInt(Date.now()) * 1_000_000n

	/**
	 * Walk from the root, one `child` per segment. `followLast` decides whether a
	 * final symlink is followed (`stat` vs `lstat`).
	 *
	 * `node` is where the walk stands and `null` is the root — the one row whose
	 * id is a constant, so a path that never lands on it costs no `get` on the
	 * hottest read in the system. `up` holds the ancestors, so `..` is a pop, and
	 * popping past the top leaves the root, which is what `/..` means.
	 */
	async function resolve(path: string, followLast: boolean): Promise<Node> {
		const queue = path.split('/').filter((s) => s !== '')
		const up: (Node | null)[] = []
		let node: Node | null = null
		let hops = 0

		for (let i = 0; i < queue.length; i++) {
			const name = queue[i]
			if (name === undefined || name === '.') continue
			if (name === '..') {
				node = up.pop() ?? null
				continue
			}

			const found = await store.child(node?.id ?? ROOT, name)
			if (found === null) throw new Error(`ENOENT: ${path}`)
			// Rule 9 again: "every parent a live directory" is the authority's to
			// keep, so a replica may hold a row parented on a file. Reachability
			// from the root is what makes a row visible, and POSIX cannot walk
			// through a file — so this one is not reachable. The test comes after
			// the lookup, not before it, to leave a name no row holds as ENOENT.
			if (node && !isDir(node)) throw new Error(`ENOTDIR: ${path}`)

			const isLast = i === queue.length - 1
			if (found.type === 'symlink' && (!isLast || followLast)) {
				if (++hops > MAX_SYMLINK_HOPS) throw new Error('ELOOP: too many levels of symbolic links')
				if (!found.link) throw new Error('EINVAL: symlink has no target')
				if (found.link.startsWith('/')) {
					up.length = 0
					node = null
				}
				// Splice the target in where the link was, so the rest of the path
				// carries on behind it and a target of its own gets the same treatment.
				queue.splice(i, 1, ...found.link.split('/').filter((s) => s !== ''))
				i--
				continue
			}

			up.push(node)
			node = found
		}

		if (node) return node
		const root = await store.get(ROOT)
		if (!root) throw new Error(`ENOENT: ${path}`) // rule 6: unreachable on a live store
		return root
	}

	/** Resolve, or `null` where the path simply is not there. */
	async function find(path: string, followLast = true): Promise<Node | null> {
		try {
			return await resolve(path, followLast)
		} catch (e) {
			if (e instanceof Error && e.message.startsWith('ENOENT')) return null
			throw e
		}
	}

	/** The directory a path is created in, and the name it takes there. */
	async function parentOf(path: string): Promise<{ dir: Node; name: string }> {
		const full = path.replace(/\/+$/, '')
		const cut = full.lastIndexOf('/')
		const name = full.slice(cut + 1)
		if (name === '' || name === '.' || name === '..') throw new Error(`EINVAL: ${path}`)
		const dir = await resolve(cut <= 0 ? '/' : full.slice(0, cut), true)
		if (!isDir(dir)) throw new Error(`ENOTDIR: ${path}`)
		return { dir, name }
	}

	/** One directory listing, page after page — the seam hands back a cursor until it is done. */
	async function* childrenOf(parent: NodeId): AsyncGenerator<Node> {
		let cursor: Cursor | undefined
		do {
			const page = await store.children(parent, cursor)
			yield* page.nodes
			cursor = page.next
		} while (cursor !== undefined)
	}

	/**
	 * Replan on a rejected guard: the row moved between this attempt's read and
	 * its commit, so the WHOLE attempt runs again on what is there now. This is
	 * what makes a read-modify-write one operation without a lock, and what makes
	 * a batch that enumerated a directory safe against a create it never saw.
	 */
	async function retry<T>(attempt: () => Promise<T>): Promise<T> {
		for (let left = MAX_ATTEMPTS; ; left--) {
			try {
				return await attempt()
			} catch (e) {
				if (left === 0 || !(e instanceof GuardError)) throw e
			}
		}
	}

	/** The guard that says "nobody wrote this row after I read it". */
	const unchanged = (node: Node): Guard => ({ version: { id: node.id, is: node.version } })

	/**
	 * The parent-mtime rule (design, `volume(store)`): a create, a delete or a
	 * rename inside a directory moves that directory's mtime, as a real filesystem
	 * does — and with it the row's version. That version is what `rm -r` guards
	 * on after enumerating, so a create it never saw cannot slip in behind it.
	 *
	 * Deliberately NOT guarded: two creates in one directory must both land, and
	 * neither depends on what the other wrote.
	 */
	const stamp = (dir: Node): Node => ({ ...dir, mtimeNs: now(), version: mint() })

	/** A tombstone is still a whole row; only `deleted` and the version speak. */
	const tomb = (node: Node): Node => ({ ...node, deleted: true, version: mint() })

	/** What a row is made of, apart from where it lives and when it changed. */
	type Payload = {
		type: Node['type']
		mode: number
		size: bigint
		content?: Hash
		link?: string
	}

	/** Whole-row replace (rule 3: no partial patch), guarded on what we read. */
	const swap = (node: Node, payload: Payload): Promise<void> =>
		store.commit(
			[
				{
					...node,
					type: payload.type,
					// The NAME keeps its permissions and its xattrs; the payload brings
					// the type bits, so a row that changes kind still says which it is.
					mode: (payload.mode & IFMT) | (node.mode & 0o7777),
					size: payload.size,
					content: payload.content,
					link: payload.link,
					mtimeNs: now(),
					version: mint()
				}
			],
			[unchanged(node)]
		)

	/** Claim a free name for a new row, and stamp the directory that gained it. */
	async function create(path: string, payload: Payload): Promise<void> {
		const { dir, name } = await parentOf(path)
		const row: Node = {
			id: crypto.randomUUID(), // minted once, never rebound
			parent: dir.id,
			name,
			mtimeNs: now(),
			version: mint(),
			...payload
		}
		try {
			await store.commit([row, stamp(dir)], [{ free: { parent: dir.id, name } }])
		} catch (e) {
			if (!(e instanceof GuardError)) throw e
			// The name went to someone else. Usually that is an ordinary race and the
			// caller replans onto the winner — but a holder the path does not resolve
			// THROUGH (a dangling symlink) will never resolve, so replanning would
			// spin. The name is taken, which is what EEXIST says.
			if ((await find(path)) === null && (await store.child(dir.id, name)) !== null)
				throw new Error(`EEXIST: ${path}`)
			throw e
		}
	}

	/**
	 * Create the row a path names, or replace the one already there — one commit
	 * either way. `exclusive` refuses a taken name (a claim, decided by the store);
	 * `update` refuses a free one (an edit, so a stale path cannot rebuild a tree).
	 */
	async function place(
		path: string,
		payload: Payload,
		opts?: { exclusive?: boolean; update?: boolean }
	): Promise<void> {
		const there = await find(path)
		if (there !== null) {
			if (opts?.exclusive) throw new Error(`EEXIST: ${path}`)
			if (isDir(there)) throw new Error(`EISDIR: ${path}`)
			return swap(there, payload)
		}
		if (opts?.update) throw new Error(`ENOENT: ${path}`)
		try {
			await create(path, payload)
		} catch (e) {
			// Losing the name IS the answer to a claim. A plain write promised
			// create-OR-overwrite and never a claim, so it replans onto the winner.
			if (opts?.exclusive && e instanceof GuardError) throw new Error(`EEXIST: ${path}`)
			throw e
		}
	}

	/**
	 * Rule 10: the bytes are durable before any row names them. A crash between
	 * the two leaves an orphan blob — the other order leaves a committed row whose
	 * content was never stored, which is lost data.
	 */
	const durable = async (data: Uint8Array): Promise<Hash> => {
		const content = await sha256Hex(data)
		await store.blobs.put(content, data)
		return content
	}

	const file = (size: number, content: Hash): Payload => ({
		type: 'file',
		mode: IFREG | 0o644,
		size: BigInt(size),
		content
	})

	/** Whole-row replace of one node — the shape of chmod, utimes and xattrs. */
	const edit = (path: string, change: (row: Node) => Node): Promise<void> =>
		retry(async () => {
			const node = await resolve(path, true)
			await store.commit([{ ...change(node), version: mint() }], [unchanged(node)])
		})

	/** Every row under a directory. Bounded by a visited set (rule 9). */
	async function descendants(id: NodeId): Promise<Node[]> {
		const out: Node[] = []
		const seen = new Set<NodeId>([id])
		const queue: NodeId[] = [id]
		for (let dir = queue.pop(); dir !== undefined; dir = queue.pop())
			for await (const child of childrenOf(dir)) {
				if (seen.has(child.id)) continue
				seen.add(child.id)
				out.push(child)
				if (isDir(child)) queue.push(child.id)
			}
		return out
	}

	const vol: Volume = {
		async stat(path) {
			return statOf(await resolve(path, true))
		},

		async lstat(path) {
			return statOf(await resolve(path, false))
		},

		async exists(path) {
			// Never throws, so every way a path can fail to be there — missing,
			// unwalkable, looping — is one answer.
			try {
				await resolve(path, false)
				return true
			} catch {
				return false
			}
		},

		async getXattr(path, name) {
			return (await resolve(path, true)).xattrs?.[name] ?? null
		},

		async setXattr(path, name, value) {
			await edit(path, (row) => ({ ...row, xattrs: { ...row.xattrs, [name]: value } }))
		},

		async listXattr(path) {
			return Object.keys((await resolve(path, true)).xattrs ?? {})
		},

		async removeXattr(path, name) {
			await edit(path, (row) => {
				const xattrs = { ...row.xattrs }
				delete xattrs[name]
				return { ...row, xattrs }
			})
		},

		async readFile(path) {
			const node = await resolve(path, true)
			if (isDir(node)) throw new Error(`EISDIR: ${path}`)
			if (node.content === undefined) return new Uint8Array()
			const data = await store.blobs.get(node.content)
			// A row may name content this replica does not hold — a lazy stub, not
			// an empty file. T9 fetches it; saying so is the only honest answer.
			if (data === null) throw new Error(`ENOENT: content ${node.content} of ${path}`)
			return data
		},

		async writeFile(path, data, opts) {
			const content = await durable(data)
			await retry(() => place(path, file(data.length, content), opts))
		},

		async appendFile(path, data) {
			await retry(async () => {
				const node = await find(path)
				if (node !== null && isDir(node)) throw new Error(`EISDIR: ${path}`)
				// Read-modify-write at the view layer: the model has no range write
				// (design #2, deliberate omissions). The guard below is what keeps the
				// read and the write one operation — a second append that lost the race
				// reads again rather than dropping the first one's entry.
				const before =
					node?.content === undefined ? new Uint8Array() : await store.blobs.get(node.content)
				if (before === null) throw new Error(`ENOENT: content ${node?.content} of ${path}`)
				const merged = new Uint8Array(before.length + data.length)
				merged.set(before)
				merged.set(data, before.length)
				const payload = file(merged.length, await durable(merged))
				// Appending to nothing is a create, and the name and the bytes still
				// commit as one fact.
				await (node === null ? create(path, payload) : swap(node, payload))
			})
		},

		async mkdir(path, opts) {
			const mode = IFDIR | (opts?.mode ?? 0o755)
			const dir: Payload = { type: 'dir', mode, size: 0n }
			if (!opts?.recursive) {
				await retry(() => place(path, dir, { exclusive: true }))
				return
			}

			const parts = path.split('/').filter((s) => s !== '')
			let walked = '/'
			for (const [i, part] of parts.entries()) {
				walked = join(walked, part)
				const there = await find(walked)
				if (there !== null) {
					// `-p` may pass over a DIRECTORY. It may not pass over a file and
					// report that the folder is there: the caller asked for a place to
					// put things, and a caller that checks first can always be overtaken.
					if (!isDir(there))
						throw new Error(i === parts.length - 1 ? `EEXIST: ${path}` : `ENOTDIR: ${walked}`)
					continue
				}
				try {
					await retry(() => place(walked, dir, { exclusive: true }))
				} catch (e) {
					// Another walk got there first. `-p` is idempotent, so a directory
					// standing where this one was going is success, not EEXIST.
					const raced = await find(walked)
					if (raced === null || !isDir(raced)) throw e
				}
			}
		},

		async readdir(path) {
			const node = await resolve(path, true)
			if (!isDir(node)) throw new Error(`ENOTDIR: ${path}`)
			const entries: Dirent[] = []
			for await (const child of childrenOf(node.id))
				entries.push({ ino: child.id, name: child.name, type: TYPE[child.type] })
			return entries
		},

		async rm(path, opts) {
			await retry(async () => {
				// The final component is not followed: `rm` removes the link, never
				// what it points at.
				const node = await find(path, false)
				if (node === null) {
					if (opts?.force) return
					throw new Error(`ENOENT: ${path}`)
				}
				const { dir } = await parentOf(path)

				const dead = [node]
				if (isDir(node)) {
					if (opts?.recursive) dead.push(...(await descendants(node.id)))
					else if ((await store.children(node.id)).nodes.length > 0)
						throw new Error(`ENOTEMPTY: ${path}`)
				}
				// One batch, one guard per row it replaces. A directory's version moves
				// on every create inside it, so an entry this walk never saw fails the
				// commit, and the attempt enumerates again.
				await store.commit([...dead.map(tomb), stamp(dir)], dead.map(unchanged))
			})
		},

		async rename(oldPath, newPath) {
			await retry(async () => {
				const from = await parentOf(oldPath)
				// Not followed, again: `mv` moves the link itself.
				const node = await store.child(from.dir.id, from.name)
				if (node === null) throw new Error(`ENOENT: ${oldPath}`)
				const to = await parentOf(newPath)
				// A directory cannot take itself as its own parent — the commit would
				// hold two rows for one id. A move onto a DEEPER descendant is the same
				// mistake, and rule 9 leaves that one to the authority's guards.
				if (to.dir.id === node.id) throw new Error(`EINVAL: ${newPath} is inside ${oldPath}`)
				const target = await store.child(to.dir.id, to.name)
				if (target?.id === node.id) return // the same row, in the same place

				// ONE row moves, whatever hangs below it: a child's location is
				// `(parent, name)`, and neither field changed. This is the O(1) move.
				const writes: Node[] = [{ ...node, parent: to.dir.id, name: to.name, version: mint() }]
				const guards: Guard[] = [unchanged(node)]
				if (target === null) guards.push({ free: { parent: to.dir.id, name: to.name } })
				else {
					// POSIX rename replaces. The displaced row is tombstoned in the SAME
					// commit, so no reader ever sees the name twice or not at all.
					writes.push(tomb(target))
					guards.push(unchanged(target))
				}
				// Both directories changed shape — one stamp when they are one directory.
				writes.push(stamp(from.dir))
				if (to.dir.id !== from.dir.id) writes.push(stamp(to.dir))
				await store.commit(writes, guards)
			})
		},

		async cp(src, dest, opts) {
			// Rows, not bytes: a copy names the content its source already stored
			// (design table A — "no byte copy; hash reuse"), which is also why a
			// symlink copies as a symlink instead of dereferencing into a fresh file.
			const node = await resolve(src, false)
			if (!isDir(node)) {
				const payload: Payload = {
					type: node.type,
					mode: node.mode,
					size: node.size,
					content: node.content,
					link: node.link
				}
				await retry(() => place(dest, payload))
				return
			}

			if (!opts?.recursive) throw new Error(`EISDIR: ${src}`)
			const there = await find(dest)
			if (there === null) await vol.mkdir(dest, { mode: node.mode & 0o7777 })
			else if (!isDir(there)) throw new Error(`ENOTDIR: ${dest}`)
			for await (const child of childrenOf(node.id))
				await vol.cp(join(src, child.name), join(dest, child.name), opts)
		},

		async symlink(target, path) {
			const payload: Payload = {
				type: 'symlink',
				mode: IFLNK | 0o777,
				size: BigInt(utf8.encode(target).length),
				link: target
			}
			await retry(() => place(path, payload, { exclusive: true }))
		},

		async readlink(path) {
			const node = await resolve(path, false)
			if (node.type !== 'symlink') throw new Error(`EINVAL: ${path} is not a symlink`)
			if (!node.link) throw new Error('EINVAL: symlink has no target')
			return node.link
		},

		async chmod(path, mode) {
			// The row carries a whole POSIX mode, so the caller's permission bits go
			// on and the type bits stay: a chmod cannot turn a file into a directory.
			await edit(path, (row) => ({ ...row, mode: (row.mode & IFMT) | (mode & 0o7777) }))
		},

		async utimes(path, mtimeNs) {
			await edit(path, (row) => ({ ...row, mtimeNs }))
		},

		async scan(path, visitor) {
			const node = await resolve(path, true)
			await visitor(path, statOf(node))
			if (!isDir(node)) return

			// Rule 9: a replica may transiently hold detached or cyclic rows, so the
			// walk bounds itself instead of trusting what it is walking to be a tree.
			const seen = new Set<NodeId>([node.id])
			async function walk(dir: NodeId, dirPath: string): Promise<void> {
				for await (const child of childrenOf(dir)) {
					if (seen.has(child.id)) continue
					seen.add(child.id)
					const childPath = join(dirPath, child.name)
					await visitor(childPath, statOf(child))
					if (isDir(child)) await walk(child.id, childPath)
				}
			}
			await walk(node.id, path)
		},

		watch: later
	}

	return vol
}

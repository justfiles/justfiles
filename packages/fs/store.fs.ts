/**
 * A `Store` over a real directory. The files themselves are the data — `cat`,
 * `git` and `just` see exactly what the volume sees — and a sidecar beside them
 * holds what POSIX has no place for: node ids, versions, xattrs, the feed order,
 * and the state each row's file was last seen in.
 *
 * Node imports are allowed in this one file of `packages/fs`, mirroring the
 * precedent of `storage.fs.ts`. A row in the sidecar is a row as JSON, and this
 * package already has exactly one definition of that (`store.http.ts`), so the
 * codec is shared rather than restated — two codecs for one shape drift. If the
 * sidecar ever needs a shape of its own, that codec moves to its own file.
 *
 * Three things are this one adapter's private problem, and none of them reaches
 * the seam:
 *
 * - **Reconciliation.** Nobody announces a change to a real tree, so `since`
 *   begins by looking: one walk, comparing what each file is now against what
 *   the sidecar last saw. What changed becomes a row, what vanished becomes a
 *   tombstone, and what is new gets an id minted for it. Reads answer from the
 *   index, so an out-of-band change reaches a consumer through the feed it
 *   already polls.
 * - **A weaker crash model.** POSIX has no transaction. Guards are all checked
 *   before anything is touched, so a REJECTED commit still writes nothing (rule
 *   2), but a commit that FAILS halfway leaves the batch half applied and the
 *   sidecar unsaved. The next scan reconciles what it can see, and a retry of
 *   the same batch heals the rest: a row the index holds but the disk never got
 *   is placed again rather than skipped as a no-op.
 * - **Content is the file.** `blobs` is not a second store beside the tree: a
 *   hash is answered by the file of a row that names it, while the disk still
 *   holds what this store last observed there. Only bytes no row has adopted yet
 *   need a home of their own (`.jfs/blobs`), and they leave it the moment a
 *   commit publishes them into a file.
 *
 * The costs are deliberate. Every `since` walks the tree, the sidecar is
 * rewritten whole on every change, and a scan reads every changed file to hash
 * it — this serves a working tree, not a warehouse. An out-of-band rename reads
 * as a delete plus a create, because `readdir` and `lstat` are all the store
 * gets and a new name is a new node to them.
 */

import type { BigIntStats } from 'node:fs'
import {
	chmod,
	lstat as lstatOf,
	mkdir,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
	type Cursor,
	ForeignCursorError,
	type Guard,
	GuardError,
	type Hash,
	HashMismatchError,
	type Node,
	type NodeId,
	ROOT,
	type Store,
	same,
	sha256Hex,
	type Version
} from './store'
import { decodeNode, encodeNode, type WireNode } from './store.http'

/** Rows per page. Big enough to list a normal directory in one page. */
const PAGE = 128

/** NUL — the one byte a name can never hold, so composed keys never collide. */
const SEP = String.fromCharCode(0)

/** The sidecar: one directory, so a local tool sees one thing it must leave alone. */
const SIDECAR = '.jfs'
const INDEX = `${SIDECAR}/index.json`
const SPILL = `${SIDECAR}/blobs`

/** What a `Hash` is: 64 hex characters. A name for content, never a path. */
const HASH = /^[0-9a-f]{64}$/

const EMPTY = new Uint8Array()

/**
 * What the disk held at a row's path the last time this store looked. `ino` is
 * the file's identity and `state` is its mode, mtime and size, so a replace that
 * kept the size and the mtime is still a change. `hash` is the content the FILE
 * holds, which is not always what the ROW names: a row that arrived ahead of its
 * bytes is a stub over an empty placeholder.
 */
type Seen = { path: string; ino: string; state: string; hash?: Hash }

/** Where a row was just put, for the observation pass at the end of a batch. */
type Landed = { id: NodeId; path: string; hash?: Hash }

/** All a node needs before the disk says what it is: an id and a place in the tree. */
type NewNode = Pick<Node, 'id' | 'parent' | 'name'> & Partial<Node>

type Entry = { node: WireNode; at: number; seen?: Seen }
type Sidecar = { lineage: string; seq: number; entries: Entry[] }

const lstat = (path: string): Promise<BigIntStats | null> =>
	lstatOf(path, { bigint: true }).catch(() => null)

/** Mode, mtime and size: everything about a file that a write to it changes. */
const stateOf = (s: BigIntStats): string => `${s.mode}:${s.mtimeNs}:${s.size}`

/** Is this still the file the row was observed at, in the state it was in? */
const unchanged = (was: Seen, s: BigIntStats): boolean =>
	was.ino === String(s.ino) && was.state === stateOf(s)

const kindOf = (s: BigIntStats): Node['type'] =>
	s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'symlink' : 'file'

/** A name that is not a name: it would resolve somewhere other than one entry. */
const unsafe = (name: string): boolean =>
	name === '' || name === '.' || name === '..' || name.includes('/')

export function fsStore(root: string): Store {
	const byId = new Map<NodeId, Node>()
	const byName = new Map<string, Set<NodeId>>() // live rows only
	// The feed, and no journal behind it: a Map iterates in insertion order, so
	// re-inserting a row on every write moves it to the end of the order.
	const order = new Map<NodeId, number>()
	const seen = new Map<NodeId, Seen>()
	let lineage = ''
	let next = 0
	/** The author tag of every version the scan mints — nothing else writes one. */
	const author = `fs:${crypto.randomUUID()}`
	let counter = 0
	const mint = (): Version => `${author}:${++counter}`

	const abs = (path: string): string => (path === '' ? root : join(root, path))

	/**
	 * One thing at a time. A scan and a commit both walk the disk against the
	 * index, so two of them at once would mint a second id for one file, or
	 * tombstone a row whose file is still being written.
	 */
	let tail: Promise<unknown> = Promise.resolve()
	const serial = <T>(work: () => Promise<T>): Promise<T> => {
		const run = tail.then(work)
		tail = run.catch(() => {})
		return run
	}

	// ── The index: two lookups over one table, exactly as `memStore` holds them ──

	const dirKey = (parent: NodeId, name: string): string => parent + SEP + name

	/** Contract rule 1: two live rows for one name resolve to the lowest id. */
	const lookup = (parent: NodeId, name: string): Node | null => {
		let best: Node | null = null
		for (const id of byName.get(dirKey(parent, name)) ?? []) {
			const n = byId.get(id)
			if (n && (!best || n.id < best.id)) best = n
		}
		return best
	}

	/** The (parent, name) index — live rows only, so a tombstone leaves it by being written. */
	const link = (row: Node): void => {
		const key = dirKey(row.parent, row.name)
		const bucket = byName.get(key) ?? new Set<NodeId>()
		byName.set(key, bucket)
		bucket.add(row.id)
	}

	const write = (row: Node): void => {
		const old = byId.get(row.id)
		if (old) byName.get(dirKey(old.parent, old.name))?.delete(old.id)
		byId.set(row.id, row)
		if (!row.deleted) link(row)
		order.delete(row.id) // rule 4: re-inserting moves the row to the end of the order
		order.set(row.id, next++)
	}

	const passes = (guard: Guard): boolean => {
		if ('free' in guard) return lookup(guard.free.parent, guard.free.name) === null
		return (byId.get(guard.version.id)?.version ?? null) === guard.version.is
	}

	const position = (cursor?: Cursor): number => {
		if (cursor === undefined) return 0
		if (!cursor.startsWith(lineage + SEP)) throw new ForeignCursorError()
		return Number(cursor.slice(lineage.length + SEP.length))
	}

	/**
	 * Where a row belongs in the tree, or null when it is not reachable from root
	 * — a detached or cyclic row (rule 9) has no path on a filesystem, so it stays
	 * a row and nothing else, which is what "invisible until reachable" means here.
	 */
	const pathOf = (row: Node): string | null => {
		const parts: string[] = []
		const walked = new Set<NodeId>()
		let at = row
		while (at.id !== ROOT) {
			if (walked.has(at.id) || unsafe(at.name)) return null
			walked.add(at.id)
			parts.unshift(at.name)
			const up = byId.get(at.parent)
			if (!up || up.deleted) return null
			at = up
		}
		return parts.join('/')
	}

	// ── The sidecar ──────────────────────────────────────────────────────────────

	const load = async (): Promise<boolean> => {
		const text = await readFile(join(root, INDEX), 'utf8').catch(() => null)
		if (text === null) return false
		const sidecar = JSON.parse(text) as Sidecar
		lineage = sidecar.lineage
		next = sidecar.seq
		// Written in feed order, so the order Map is rebuilt by reading it through.
		for (const entry of sidecar.entries) {
			const row = decodeNode(entry.node)
			byId.set(row.id, row)
			if (!row.deleted) link(row)
			order.set(row.id, entry.at)
			if (entry.seen) seen.set(row.id, entry.seen)
		}
		return true
	}

	/**
	 * The whole index, published under a private name and renamed over the old one
	 * — a half-written sidecar would lose every id in the tree. A crash before the
	 * rename loses the ids minted since the last save, and the next scan mints new
	 * ones: the weaker crash model, in the one place it costs something.
	 */
	const save = async (): Promise<void> => {
		const entries: Entry[] = []
		for (const [id, at] of order) {
			const node = byId.get(id)
			if (node) entries.push({ node: encodeNode(node), at, seen: seen.get(id) })
		}
		const sidecar: Sidecar = { lineage, seq: next, entries }
		await publish(join(root, INDEX), (tmp) => writeFile(tmp, JSON.stringify(sidecar)))
	}

	// ── The disk ─────────────────────────────────────────────────────────────────

	/**
	 * Take a name in ONE operation: build the payload under a private sibling and
	 * rename it over the target. POSIX has no atomic content write, so a reader
	 * that resolves the name while `write` is still looping reads a prefix of it.
	 * A SIBLING, because `rename` cannot cross a filesystem and a tree can have
	 * another mount underneath it.
	 */
	const publish = async (os: string, build: (tmp: string) => Promise<void>): Promise<void> => {
		const tmp = `${os}.jfs-${crypto.randomUUID()}`
		try {
			await build(tmp)
			await rename(tmp, os)
		} finally {
			// Covers the whole lifecycle, not just the rename: a write that failed
			// halfway would otherwise strand its temp file, and repeated failures
			// would quietly consume the disk.
			await rm(tmp, { force: true })
		}
	}

	/** Does the disk still hold the file this row named? Identity is the inode. */
	const mine = async (was: Seen): Promise<boolean> => {
		const s = await lstat(abs(was.path))
		return s !== null && String(s.ino) === was.ino
	}

	/**
	 * Remove what a row named — but only while the disk still holds THAT file. A
	 * rename inside the same batch may have put another row's file at the path,
	 * and a commit does not get to say which of its writes goes first.
	 */
	const remove = async (was: Seen): Promise<void> => {
		if (await mine(was)) await rm(abs(was.path), { recursive: true, force: true })
	}

	/** A directory moved, so every path under it moved with it. */
	const moveSeen = (from: string, to: string): void => {
		const under = `${from}/`
		for (const [id, was] of seen) {
			if (was.path === from) seen.set(id, { ...was, path: to })
			else if (was.path.startsWith(under))
				seen.set(id, { ...was, path: to + was.path.slice(from.length) })
		}
	}

	/**
	 * The bytes of a file row, and the hash the file ends up holding. Three cases
	 * and no more: the file already holds what the row names (a rename, a chmod, a
	 * re-commit), the row names bytes this store has, or it names bytes this store
	 * does not have — a lazy stub, where the name appears empty and the content
	 * fills in when it arrives, without the row moving at all.
	 */
	const fill = async (
		os: string,
		row: Node,
		old: Node | null,
		there: Seen | undefined
	): Promise<Hash | undefined> => {
		if (row.content === undefined) {
			// No content is a claim too, so a row that dropped its hash empties its file.
			if (there && old?.content === undefined) return undefined
			await publish(os, (tmp) => writeFile(tmp, EMPTY))
			return undefined
		}
		if (there?.hash === row.content) return there.hash
		const data = await readBlob(row.content)
		if (data !== null) {
			await publish(os, (tmp) => writeFile(tmp, data))
			return row.content
		}
		if (there) return there.hash // the row is a stub over whatever the file holds
		await publish(os, (tmp) => writeFile(tmp, EMPTY))
		return undefined
	}

	/** Put one row on the disk. Null when there is nothing on the disk to put. */
	const place = async (row: Node, old: Node | null): Promise<Landed | null> => {
		let at = seen.get(row.id)
		if (row.deleted) {
			if (at) await remove(at)
			seen.delete(row.id)
			return null
		}
		if (row.id === ROOT) return null // the directory this store IS
		const path = pathOf(row)
		if (path === null) return null
		const os = abs(path)
		// Only when the parent is not already there — the ancestors of a row this
		// batch also creates may not have been placed yet, and a commit does not get
		// to say which of its writes goes first.
		if (!seen.has(row.parent)) await mkdir(dirname(os), { recursive: true })

		// The row names a path other than the one its file sits at: ONE rename,
		// whatever the subtree under it holds.
		if (at && at.path !== path) {
			if (await mine(at)) {
				await rename(abs(at.path), os)
				moveSeen(at.path, path)
				at = { ...at, path }
			} else {
				seen.delete(row.id) // that file is gone, or is another row's now
				at = undefined
			}
		}
		// A file where a directory was, or the other way round: the old one goes.
		if (at && old && old.type !== row.type) {
			await remove(at)
			seen.delete(row.id)
			at = undefined
		}

		let hash = at?.hash
		if (row.type === 'symlink') {
			await publish(os, (tmp) => symlink(row.link ?? '', tmp))
		} else if (row.type === 'file') {
			hash = await fill(os, row, old, at)
		} else {
			// A mount is a junction into another store, which reads as a directory to
			// anything local — and as an empty one until that store is bound.
			await mkdir(os, { recursive: true })
		}
		// A symlink's own mode is not settable on every platform, and nothing reads it.
		if (row.type !== 'symlink') await chmod(os, row.mode & 0o7777)
		return { id: row.id, path, hash }
	}

	/**
	 * Record what the disk holds now. Deferred to the end of a batch on purpose:
	 * adding, removing or renaming an entry bumps a DIRECTORY's mtime, and a
	 * directory row nobody wrote must not turn up in the feed for it — which is
	 * what the next scan would do if it found a state no one had taken down.
	 */
	const observe = async (placed: Landed[], dirs: Set<NodeId>): Promise<void> => {
		const where = new Map<NodeId, Landed>(placed.map((landed) => [landed.id, landed]))
		for (const id of dirs) {
			const was = seen.get(id)
			if (was && !where.has(id)) where.set(id, { id, path: was.path, hash: was.hash })
		}
		for (const [id, landed] of where) {
			const s = await lstat(abs(landed.path))
			if (s === null) seen.delete(id)
			else
				seen.set(id, {
					path: landed.path,
					ino: String(s.ino),
					state: stateOf(s),
					hash: landed.hash
				})
		}
	}

	// ── The scan: where a change nobody announced becomes a row ──────────────────

	const hashOf = async (os: string): Promise<Hash | null> => {
		const data = await readFile(os).catch(() => null)
		return data === null ? null : sha256Hex(data)
	}

	/** The row a file states it is. Everything POSIX knows about it, and nothing else. */
	const derive = async (path: string, s: BigIntStats, base: NewNode): Promise<Node | null> => {
		const row: Node = {
			id: base.id,
			parent: base.parent,
			name: base.name,
			type: kindOf(s),
			// The whole POSIX mode, exactly as node:fs hands it back.
			mode: Number(s.mode),
			mtimeNs: s.mtimeNs,
			size: s.size,
			version: mint()
		}
		// No node API carries an xattr, so the sidecar is their only home: a file
		// that changed keeps the ones its row already had.
		if (base.xattrs) row.xattrs = base.xattrs
		if (row.type === 'symlink') {
			const target = await readlink(abs(path)).catch(() => null)
			if (target === null) return null
			row.link = target
		}
		if (row.type === 'file') {
			const hash = await hashOf(abs(path))
			if (hash === null) return null // unreadable: leave the row alone, and try again next scan
			row.content = hash
		}
		return row
	}

	/**
	 * Was this path removed from the tree? Gone means a directory the scan DID
	 * read failed to list the step below it — so an unreadable directory never
	 * spells the loss of the subtree under it, and a directory that vanished takes
	 * its whole subtree with it.
	 */
	const missing = (path: string, read: Set<string>, found: Set<string>): boolean => {
		let at = ''
		for (const part of path.split('/')) {
			const below = at === '' ? part : `${at}/${part}`
			if (read.has(at) && !found.has(below)) return true
			at = below
		}
		return false
	}

	/**
	 * Reconcile the index against the tree. This is `since`'s first act, because
	 * on a real filesystem the feed cannot be a record of commits: anything may
	 * have written, created or removed a file, and looking is the only way to know.
	 */
	const scan = async (): Promise<void> => {
		const found = new Set<string>() // paths the walk saw
		const read = new Set<string>() // directories the walk could list
		let changed = false

		/** Take the disk's word for what is at `path`: the row it becomes, or null when it cannot be read. */
		const adopt = async (path: string, s: BigIntStats, base: NewNode): Promise<Node | null> => {
			const derived = await derive(path, s, base)
			if (derived === null) return null
			write(derived)
			seen.set(derived.id, { path, ino: String(s.ino), state: stateOf(s), hash: derived.content })
			changed = true
			return derived
		}

		const visit = async (dir: NodeId, path: string): Promise<void> => {
			const names = await readdir(abs(path)).catch(() => null)
			if (names === null) return // unreadable: not a reason to bury what is under it
			read.add(path)
			for (const name of names) {
				if (path === '' && name === SIDECAR) continue
				const below = path === '' ? name : `${path}/${name}`
				const s = await lstat(abs(below))
				if (s === null) continue // it vanished between the listing and the look
				found.add(below)
				const row = lookup(dir, name)
				const was = row ? seen.get(row.id) : undefined
				// A name the index does not hold, or holds at another state, is news. An id
				// is minted here only for a node this store has never seen.
				const here =
					row && was && was.path === below && unchanged(was, s)
						? row
						: await adopt(below, s, row ?? { id: crypto.randomUUID(), parent: dir, name })
				if (here && (here.type === 'dir' || here.type === 'mount')) await visit(here.id, below)
			}
		}

		// Root has no parent to notice that it changed, so its own state is checked
		// here.
		const s = await lstat(root)
		const rootRow = byId.get(ROOT)
		if (s === null || !rootRow) return
		const was = seen.get(ROOT)
		if (!was || !unchanged(was, s)) await adopt('', s, rootRow)
		await visit(ROOT, '')

		// What the walk did not find is gone.
		for (const [id, at] of [...seen]) {
			if (at.path === '' || !missing(at.path, read, found)) continue
			seen.delete(id)
			const row = byId.get(id)
			if (!row || row.deleted) continue
			write({ ...row, deleted: true, version: mint() })
			changed = true
		}
		if (changed) await save()
	}

	// ── Content: the files themselves ────────────────────────────────────────────

	/** Where bytes wait while no row names them yet. Null for a key that is no hash. */
	const spill = (hash: Hash): string | null => (HASH.test(hash) ? join(root, SPILL, hash) : null)

	/**
	 * The file that holds these bytes: the row that names the hash, while the disk
	 * still holds what this store last observed there. A walk and not an index,
	 * because the index that matters is on the row.
	 */
	const fileFor = async (hash: Hash): Promise<string | null> => {
		for (const at of seen.values()) {
			if (at.hash !== hash) continue
			const s = await lstat(abs(at.path))
			if (s !== null && unchanged(at, s)) return abs(at.path)
		}
		return null
	}

	/** The bytes a hash names: the spill, or else the file of a row that names it. */
	const readBlob = async (hash: Hash): Promise<Uint8Array | null> => {
		const found = (await readAt(spill(hash))) ?? (await readAt(await fileFor(hash)))
		// Not the `Buffer` node hands back: the seam says `Uint8Array`, and a caller
		// that compares what it read against what it wrote must find the same thing.
		// Each read is its own buffer anyway, so nothing can reach into stored content.
		return found === null ? null : new Uint8Array(found)
	}

	/** A whole file, or null: the path may be nothing, gone, or unreadable. */
	const readAt = async (os: string | null): Promise<Uint8Array | null> =>
		os === null ? null : readFile(os).catch(() => null)

	// ── Opening ──────────────────────────────────────────────────────────────────

	const start = async (): Promise<void> => {
		// Creates the tree itself when it is not there — and BEFORE root's state is
		// taken down, so the sidecar's own arrival is not a change to it.
		await mkdir(join(root, SPILL), { recursive: true })
		if (!(await load())) {
			lineage = crypto.randomUUID() // rule 11: a fresh sidecar is a fresh lineage
			const s = await lstat(root)
			const seed = s === null ? null : await derive('', s, { id: ROOT, parent: ROOT, name: '' })
			// Rule 6: the root row, and the one row whose id is not minted here.
			if (s === null || seed === null) throw new Error(`fsStore: cannot read ${root}`)
			write(seed)
			seen.set(ROOT, { path: '', ino: String(s.ino), state: stateOf(s) })
		}
		// The index is rebuilt against the tree on open, so a path resolves the
		// moment the store is there — a consumer does not have to poll first.
		await scan()
	}

	let opening: Promise<void> | null = null
	// Not serialized: everything below awaits this before it takes its turn, so
	// nothing can interleave with the open itself.
	const open = (): Promise<void> => (opening ??= start())

	const copy = (n: Node): Node => structuredClone(n)

	return {
		async get(id) {
			await open()
			const n = byId.get(id)
			return n ? copy(n) : null
		},

		async child(parent, name) {
			await open()
			const n = lookup(parent, name)
			return n ? copy(n) : null
		},

		async children(parent, cursor) {
			await open()
			const sorted = [...byId.values()]
				.filter((n) => n.parent === parent && !n.deleted && n.id !== ROOT)
				.sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1))
			// One row per name: a duplicate sorts next to its winner, so skipping every
			// row whose name is not past the last one emitted drops the losers and
			// resumes a paged listing in one step. That makes the cursor just a name.
			const nodes: Node[] = []
			let last = cursor
			let more = false
			for (const n of sorted) {
				if (last !== undefined && n.name <= last) continue
				if (nodes.length === PAGE) {
					more = true
					break
				}
				nodes.push(copy(n))
				last = n.name
			}
			return more && last !== undefined ? { nodes, next: last } : { nodes }
		},

		async since(cursor) {
			await open()
			const from = position(cursor) // rule 11, before any work: a fenced cursor buys no scan
			await serial(scan)
			const nodes: Node[] = []
			for (const [id, at] of order) {
				if (at < from) continue
				if (nodes.length === PAGE) return { nodes, next: lineage + SEP + at }
				const row = byId.get(id)
				if (row) nodes.push(copy(row))
			}
			return { nodes, next: lineage + SEP + next }
		},

		/**
		 * Rule 2: every guard is checked before anything is touched, so a REJECTED
		 * commit writes nothing. A commit that FAILS is the weaker model this
		 * backend documents — POSIX has no transaction to roll back.
		 */
		async commit(writes, guards) {
			// Taken before the first await, which is where the caller gets control
			// back and may edit a row it just handed over (rule 3).
			const batch = structuredClone(writes)
			const checks = structuredClone(guards)
			await open()
			return serial(async () => {
				for (const guard of checks ?? []) if (!passes(guard)) throw new GuardError(guard)

				const todo: { row: Node; old: Node | null; fresh: boolean }[] = []
				for (const row of batch) {
					const old = byId.get(row.id) ?? null
					const fresh = !(old && same(old, row))
					// Rule 3: a row the store already holds is a no-op — unless the disk
					// never got it, which is how a retry after a failed write heals.
					if (fresh || (!row.deleted && !seen.has(row.id))) todo.push({ row, old, fresh })
				}
				if (todo.length === 0) return

				// The rows first, so a path resolves through rows this same batch adds:
				// a new directory and a file inside it, in either order.
				for (const { row, fresh } of todo) if (fresh) write(row)
				const placed: Landed[] = []
				const dirs = new Set<NodeId>()
				for (const { row, old } of todo) {
					const landed = await place(row, old)
					if (landed) placed.push(landed)
					dirs.add(row.parent)
					if (old) dirs.add(old.parent)
				}
				await observe(placed, dirs)
				// The bytes live in their file now, so the copy that carried them there
				// goes: content is the file itself here, never a second store beside it.
				for (const landed of placed) {
					const waiting = landed.hash === undefined ? null : spill(landed.hash)
					if (waiting !== null) await rm(waiting, { force: true })
				}
				await save()
			})
		},

		// No `subscribe`. Rule 8 makes it optional, and a consumer takes it INSTEAD
		// of polling `since` whenever a store offers one — which would blind it to
		// the very changes this backend exists for: an edit made outside the store
		// tells no one, and only a scan finds it. Polling `since` scans.

		blobs: {
			async has(hash) {
				await open()
				const waiting = spill(hash)
				if (waiting !== null && (await lstat(waiting)) !== null) return true
				return (await fileFor(hash)) !== null
			},

			async get(hash) {
				await open()
				return readBlob(hash)
			},

			/**
			 * Rule 7: content-keyed and immutable, so bytes already here are already
			 * the answer and a second put is nothing. What lands is a snapshot taken
			 * before the first await — the caller may edit its array the moment this
			 * returns to it.
			 */
			async put(hash, data) {
				const held = new Uint8Array(data)
				await open()
				const waiting = spill(hash)
				// A key that is not a digest names no file here, and nothing could ever
				// hash to it: the bytes contradict the name they were offered under.
				if (waiting === null) throw new HashMismatchError(hash)
				if ((await lstat(waiting)) !== null) return
				if ((await fileFor(hash)) !== null) return
				await publish(waiting, (tmp) => writeFile(tmp, held))
			}
		}
	}
}

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
 *   begins by looking. Three tiers, because a watcher is fast and a walk is the
 *   truth: the paths the OS named, every call; every directory, on the cheap
 *   floor; every file, on the deep one. What a directory lists that the index
 *   does not know becomes a row, what it no longer lists becomes a tombstone, and
 *   what changed underneath becomes a new version. Reads answer from the index,
 *   so a change made outside reaches a consumer through the feed it already
 *   polls. A junction is where the walk stops: a mount holds no rows of this
 *   store, on the disk as at the seam (`holdsRows`).
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
 *   commit — or a `put` for a row that was waiting — publishes them into a file.
 *
 * Two rules carry the weight, and every case below is one of them:
 *
 * - **One path, one owner.** `seen` says where a row's file is; `owner` says
 *   whose file a path is. A scan asks `owner` before it asks the tree, so a file
 *   is never adopted twice under two ids, and nothing removes or renames over a
 *   file it does not own. When two live rows claim one name — a state the contract
 *   allows (rule 1) — the disk holds the one the rows resolve to, the lowest id,
 *   because a local tool reading that path must see what the store answers.
 * - **A live row with no path keeps its bytes.** Visibility is reachability (rule
 *   9), so a row whose parent is missing, buried, cyclic or not a directory has no
 *   path — and neither has one that lost a contested name — but it is still live,
 *   and on this backend its file is the only copy of its content. Its file moves to
 *   a holding area inside the sidecar, where the scan never looks and `blobs` still
 *   can; a later commit that gives the row a place renames it back, which is the
 *   same rename any move is. Nothing needs to name the row for that: whatever makes
 *   it reachable — a commit, or a scan that finds a name freed or a directory where
 *   a file was — is what puts it on the disk, because nothing else ever looks in
 *   there for it.
 *
 * The costs are deliberate. The sidecar is rewritten whole on every change, and a
 * scan reads every changed file to hash it — this serves a working tree, not a
 * warehouse. `DEEP_MS` is the knob a large tree turns: at thirty thousand files a
 * deep look is ~700ms, so a consumer polling a tree that size pays a few percent
 * of a core for the backstop, and everything else is milliseconds. An out-of-band
 * rename reads as a delete plus a create, because `readdir` and `lstat` are all
 * the store gets and a new name is a new node to them.
 */

import type { BigIntStats } from 'node:fs'
import { type FSWatcher, watch } from 'node:fs'
import {
	chmod,
	lstat as lstatOf,
	lutimes,
	mkdir,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	rmdir,
	symlink,
	writeFile
} from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
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
/** Where the file of a row the tree cannot reach waits for a place in it. */
const HOLD = `${SIDECAR}/detached`

/** What a `Hash` is: 64 hex characters. A name for content, never a path. */
const HASH = /^[0-9a-f]{64}$/

/**
 * How long between looks. Cheap ones: one `lstat` per DIRECTORY, whose mtime
 * moves when an entry is added, removed or renamed in it — every structural
 * change, for about one percent of a walk. A store with no watcher walks
 * everything on this same floor instead, since nothing else will ever tell it.
 *
 * Without a floor at all, a consumer polling `since` every few tens of
 * milliseconds (`WATCH_BURST_MS`) would have a tree of any size walked back to
 * back. Exported for tests only — a store that answers on a timer has no other
 * honest way to say "not yet".
 */
export const SWEEP_MS = 1_000

/**
 * How long between the deep looks: one `lstat` per FILE, which is the only thing
 * that finds an in-place write nobody announced.
 *
 * It stays rare because a watcher usually reports those in milliseconds — and it
 * stays, because a watcher is not a source of truth. A recursive `fs.watch` DROPS
 * events: measured on macOS, a process holding a few dozen watchers loses them
 * outright. So the walk is the guarantee and the watcher is the latency, which is
 * how the seam already frames `subscribe`.
 */
const DEEP_MS = 5_000

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

/**
 * What a row states about its object, on the object: the two fields POSIX keeps for
 * it. Every path that creates or replaces a file ends here, because a file that
 * arrives with `writeFile`'s mode and this moment's stamp is not the one the row
 * describes — and this backend's whole premise is that a local tool sees the row.
 *
 * `lutimes`, so a symlink gets its own stamp rather than its target's, and
 * milliseconds, because that is what a `Date` carries — the same trade
 * `storage.fs.ts` already makes for the same field. The row keeps every nanosecond
 * it was given; the disk takes what POSIX takes.
 */
const meta = async (os: string, row: Node): Promise<void> => {
	// A symlink's own mode is not settable on every platform, and nothing reads it.
	if (row.type !== 'symlink') await chmod(os, row.mode & 0o7777)
	const at = new Date(Number(row.mtimeNs / 1_000_000n))
	await lutimes(os, at, at)
}

const kindOf = (s: BigIntStats): Node['type'] =>
	s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'symlink' : 'file'

/** Does this row hold entries on the disk? A mount stands where a directory would. */
const isDir = (row: Node): boolean => row.type === 'dir' || row.type === 'mount'

/**
 * Can rows of THIS store live under it? Only a directory can. A mount's children
 * live in the store it is bound to, which is the boundary `authority.ts` refuses a
 * commit over — and this is the same rule on the disk: nothing of this store's is
 * placed inside a junction, and nothing found inside one is adopted. The design
 * leans its whole local-data story on it, so both halves have to hold.
 */
const holdsRows = (row: Node): boolean => row.type === 'dir'

/**
 * A name that is not a name: it would resolve somewhere other than one entry, or
 * nowhere at all. `SEP` is the last of those and the bluntest — a NUL is the one
 * byte a name cannot hold, which is why every backend composes keys with it, and
 * `node:fs` refuses a path containing one outright. A page carrying such a row must
 * not be a page this replica can never apply.
 */
const unsafe = (name: string): boolean =>
	name === '' || name === '.' || name === '..' || name.includes('/') || name.includes(SEP)

const parentOf = (path: string): string => {
	const cut = path.lastIndexOf('/')
	return cut === -1 ? '' : path.slice(0, cut)
}

export function fsStore(root: string): Store {
	const byId = new Map<NodeId, Node>()
	/**
	 * parent → name → ids, live rows only. One index for both jobs the tree has:
	 * the `(parent, name)` lookup, and the listing of a directory — which is also
	 * what a scan needs to know what a directory used to hold.
	 */
	const tree = new Map<NodeId, Map<string, Set<NodeId>>>()
	// The feed, and no journal behind it: a Map iterates in insertion order, so
	// re-inserting a row on every write moves it to the end of the order.
	const order = new Map<NodeId, number>()
	/** id → where its file is, and what that file held when this store last looked. */
	const seen = new Map<NodeId, Seen>()
	/** path → the row whose file sits there. One path, one owner. */
	const owner = new Map<string, NodeId>()
	/** hash → the rows whose file holds those bytes: the content map, read backwards. */
	const holders = new Map<Hash, Set<NodeId>>()
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

	// ── The rows ─────────────────────────────────────────────────────────────────

	const link = (row: Node): void => {
		const names = tree.get(row.parent) ?? new Map<string, Set<NodeId>>()
		tree.set(row.parent, names)
		const ids = names.get(row.name) ?? new Set<NodeId>()
		names.set(row.name, ids)
		ids.add(row.id)
	}

	const unlink = (row: Node): void => {
		const names = tree.get(row.parent)
		const ids = names?.get(row.name)
		if (!names || !ids) return
		ids.delete(row.id)
		if (ids.size === 0) names.delete(row.name)
		if (names.size === 0) tree.delete(row.parent)
	}

	const write = (row: Node): void => {
		const old = byId.get(row.id)
		if (old && !old.deleted) unlink(old)
		byId.set(row.id, row)
		if (!row.deleted) link(row)
		order.delete(row.id) // rule 4: re-inserting moves the row to the end of the order
		order.set(row.id, next++)
	}

	/** Contract rule 1: two live rows for one name resolve to the lowest id. */
	const lookup = (parent: NodeId, name: string): Node | null => {
		let best: Node | null = null
		for (const id of tree.get(parent)?.get(name) ?? []) {
			const n = byId.get(id)
			if (n && (!best || n.id < best.id)) best = n
		}
		return best
	}

	/** Live children of a directory, in name order. Root is nobody's child. */
	const namesIn = (parent: NodeId): string[] =>
		[...(tree.get(parent)?.keys() ?? [])].filter((name) => name !== '' || parent !== ROOT).sort()

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
	 * Where a row belongs in the tree, or null when it has no place on the disk —
	 * because nothing can reach it from root (a row that is detached, cyclic, under
	 * something that is not a directory, or under a name that is not its own, rule 9),
	 * or because the name it asks for is the sidecar's. Either way its file goes to the
	 * holding area instead: a row called `.jfs` must not be able to write over the
	 * index that knows what every row is.
	 *
	 * It is the one answer to "whose path is this", which is why the walk asks rule 1
	 * at every step rather than only of the row: a name belongs to the lowest id that
	 * claims it, and everything under a duplicate that lost is as unreachable as the
	 * duplicate itself — exactly what a volume resolving name by name finds.
	 */
	const pathOf = (row: Node): string | null => {
		const parts: string[] = []
		const walked = new Set<NodeId>()
		let at = row
		while (at.id !== ROOT) {
			if (walked.has(at.id) || unsafe(at.name)) return null
			walked.add(at.id)
			parts.unshift(at.name)
			// The name has to be this row's to have. Two live rows for one name is a state
			// the contract allows (rule 1), and only the lowest id has a path — otherwise
			// two rows in ONE batch would write over each other's file, and the second
			// `rename` onto what the first left fails and wedges the page for good.
			if (lookup(at.parent, at.name)?.id !== at.id) return null
			const up = byId.get(at.parent)
			// Missing, buried, or not a directory at all: a page may re-type a file into
			// the directory this row belongs to and arrive AFTER the rows that fill it,
			// and nothing is reachable through a file. Writing under one would fail with
			// ENOTDIR and wedge the replica on that page for good.
			if (!up || up.deleted || !holdsRows(up)) return null
			at = up
		}
		return parts[0] === SIDECAR ? null : parts.join('/')
	}

	/**
	 * The path a `(parent, name)` would resolve to — the question `pathOf` answers for
	 * a row, asked of a name no row may hold yet. Null when the parent has no path of
	 * its own, which is when nothing under it can be reached either.
	 */
	const pathUnder = (parent: NodeId, name: string): string | null => {
		if (unsafe(name)) return null
		if (parent === ROOT) return name === SIDECAR ? null : name
		const up = byId.get(parent)
		if (!up || up.deleted || !holdsRows(up)) return null
		const dir = pathOf(up)
		return dir === null ? null : `${dir}/${name}`
	}

	// ── What the disk holds: `seen`, and the two indexes over it ─────────────────

	const mark = (id: NodeId, at: Seen): void => {
		unmark(id)
		// One path, one owner: whoever held this path before does not have a file
		// there any more, whether we replaced it or renamed over it.
		const held = owner.get(at.path)
		if (held !== undefined) unmark(held)
		seen.set(id, at)
		owner.set(at.path, id)
		if (at.hash !== undefined) holders.set(at.hash, (holders.get(at.hash) ?? new Set()).add(id))
	}

	const unmark = (id: NodeId): void => {
		const was = seen.get(id)
		if (!was) return
		seen.delete(id)
		if (owner.get(was.path) === id) owner.delete(was.path)
		if (was.hash === undefined) return
		const bucket = holders.get(was.hash)
		bucket?.delete(id)
		if (bucket?.size === 0) holders.delete(was.hash)
	}

	/**
	 * Would a recursive `rm` at this path take a file this store still tracks? The
	 * question that has to be asked before one runs: what is under a directory may
	 * belong to rows nobody deleted, and their files are the only copy of their bytes
	 * there is. `was` is what the disk holds there, when the caller knows — only a
	 * directory can hold anything, and asking is a walk of everything this store has
	 * seen.
	 */
	const holdsFiles = (path: string, was: Node | null = null): boolean => {
		if (was && !isDir(was)) return false
		const under = `${path}/`
		for (const at of seen.values()) if (at.path.startsWith(under)) return true
		return false
	}

	/** A directory moved, so every path under it moved with it. */
	const moveSeen = (from: string, to: string): void => {
		const under = `${from}/`
		for (const [id, at] of [...seen]) {
			if (at.path === from) mark(id, { ...at, path: to })
			else if (at.path.startsWith(under)) mark(id, { ...at, path: to + at.path.slice(from.length) })
		}
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
			if (entry.seen) mark(row.id, entry.seen)
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
	const mine = async (at: Seen): Promise<boolean> => {
		const s = await lstat(abs(at.path))
		return s !== null && String(s.ino) === at.ino
	}

	/**
	 * Remove what a row named — but only while the disk still holds THAT file. A
	 * rename inside the same batch may have put another row's file at the path,
	 * and a commit does not get to say which of its writes goes first.
	 */
	const remove = async (at: Seen): Promise<void> => {
		if (!(await mine(at))) return
		await rm(abs(at.path), { recursive: true, force: true })
		// An empty container in the holding area is nobody's row, so it goes too.
		for (let up = parentOf(at.path); up.startsWith(HOLD); up = parentOf(up))
			if (
				!(await rmdir(abs(up)).then(
					() => true,
					() => false
				))
			)
				return
	}

	/**
	 * A live row with no path of its own still owns bytes, and on this backend they
	 * are the only copy — whether nothing can reach it, or another row holds the name
	 * it asks for. Its file leaves the namespace for the holding area, where the scan
	 * never looks and `blobs` still finds it. ONE rename, whatever the subtree under
	 * it holds.
	 */
	const park = async (id: NodeId, at: Seen): Promise<void> => {
		// The id names its place in there. A second name for it is only needed when
		// files this store still tracks are under the first — a subtree an earlier park
		// left behind, which is not this one's to delete. Anything else at the name is
		// a leftover: a crash between the rename and the save that recorded it.
		const its = `${HOLD}/${id}`
		if (at.path === its || at.path.startsWith(`${its}-`)) return // already in its place
		if (!(await mine(at))) {
			unmark(id)
			return
		}
		const to = holdsFiles(its) ? `${its}-${crypto.randomUUID()}` : its
		await mkdir(join(root, HOLD), { recursive: true })
		await rm(abs(to), { recursive: true, force: true })
		await rename(abs(at.path), abs(to))
		moveSeen(at.path, to)
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
		at: Seen | undefined
	): Promise<Hash | undefined> => {
		if (row.content === undefined) {
			// No content is a claim too, so a row that dropped its hash empties its file.
			if (at && old?.content === undefined) return undefined
			await publish(os, (tmp) => writeFile(tmp, EMPTY))
			return undefined
		}
		if (at?.hash === row.content) return at.hash
		const data = await readBlob(row.content)
		if (data !== null) {
			await publish(os, (tmp) => writeFile(tmp, data))
			return row.content
		}
		if (at) return at.hash // the row is a stub over whatever the file holds
		await publish(os, (tmp) => writeFile(tmp, EMPTY))
		return undefined
	}

	/** Put one row on the disk, at the path the tree gives it. Null when there is nothing to put. */
	const put = async (row: Node, old: Node | null, path: string | null): Promise<Landed | null> => {
		let at = seen.get(row.id)
		// The directory this store IS. There is nothing to create, move or remove: rule
		// 6 says root is never buried, and a replica that holds a tombstone for it
		// anyway must not act on one — the one path this store may not touch is its own
		// root. Its mode and its stamp are as real as any other row's, though, and a
		// volume that chmods `/` means the directory a local tool sees.
		if (row.id === ROOT) {
			if (row.deleted) return null
			await meta(root, row)
			return { id: ROOT, path: '' }
		}
		if (row.deleted) {
			if (at) {
				// A batch may tombstone a directory a page before the rows inside it, so
				// what is under it decides: nothing of this store's underneath, and the
				// subtree goes; anything still tracked there, and it is parked with its
				// bytes intact — a recursive `rm` does not get to take a file it is not
				// deleting.
				if (holdsFiles(at.path, old)) await park(row.id, at)
				else await remove(at)
			}
			unmark(row.id)
			return null
		}
		if (path === null) {
			if (at) await park(row.id, at)
			return null
		}
		const os = abs(path)

		// The directory this row goes in, when the index does not already have it
		// THERE: a row whose parent is not on the disk at all still lands, which is how
		// a row that was parked, or one whose write failed halfway, comes back.
		if (seen.get(row.parent)?.path !== parentOf(path)) await mkdir(dirname(os), { recursive: true })

		// Another row's file is at this path already: a duplicate that used to hold the
		// name, or a row this same batch moves elsewhere and has not placed yet. This
		// row has the path — `pathOf` said so — but the file there is the only copy of
		// the other row's bytes, so it is parked rather than renamed over, and comes
		// back when its own turn or its own name comes.
		const taken = owner.get(path)
		if (taken !== undefined && taken !== row.id) {
			const held = seen.get(taken)
			if (held) {
				await park(taken, held)
				at = seen.get(row.id) // parking a directory moved whatever was under it
			}
		}

		// The row names a path other than the one its file sits at: ONE rename,
		// whatever the subtree under it holds. A parked file comes back the same way.
		if (at && at.path !== path) {
			if (await mine(at)) {
				await rename(abs(at.path), os)
				moveSeen(at.path, path)
				at = seen.get(row.id)
			} else {
				unmark(row.id) // that file is gone, or is another row's now
				at = undefined
			}
		}
		// A file where a directory was, or the other way round: the old one goes — and
		// goes the same way a tombstoned directory does, because what was inside it may
		// be live rows whose own pages have not arrived yet. The name has to be free
		// either way, so the subtree is parked rather than removed.
		if (at && old && old.type !== row.type) {
			if (holdsFiles(at.path, old)) await park(row.id, at)
			else await remove(at)
			unmark(row.id)
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
		await meta(os, row)
		return { id: row.id, path, hash }
	}

	/**
	 * A row on the disk, and the rows that may have to move because of it. Neither is
	 * in the batch, and neither ever will be: the engine's cursor is past the page
	 * that carried them, so this commit is the only chance their files get.
	 *
	 * - A name this row LEFT — by being tombstoned, by moving, or by losing its place
	 *   in the tree — may still be claimed by a live row waiting in the holding area,
	 *   and that row is the winner now.
	 * - A DIRECTORY that has just arrived, moved, or stopped being a file is the place
	 *   rows were waiting for. A page routinely carries a child before its parent
	 *   (rule 9), and a row nothing could reach has no file.
	 */
	const place = async (row: Node, old: Node | null, path: string | null): Promise<Landed[]> => {
		const was = seen.get(row.id)?.path
		const landed = await put(row, old, path)
		const out = landed ? [landed] : []
		if (old && !old.deleted && (row.deleted || old.parent !== row.parent || old.name !== row.name))
			out.push(...(await promote(old.parent, old.name)))
		// Not when the row already HELD ROWS at this very path: that is every ordinary
		// write, and its children are where they belong. A junction does not count — it
		// held none, so whatever was waiting under it has been waiting all along.
		if (landed && !(old && holdsRows(old) && was === landed.path)) out.push(...(await adopt(row)))
		return out
	}

	/** Put the live row that claims this name where the tree says it goes, if it is not there. */
	const promote = async (parent: NodeId, name: string): Promise<Landed[]> => {
		const winner = lookup(parent, name)
		if (!winner) return []
		const path = pathOf(winner)
		if (path === null || seen.get(winner.id)?.path === path) return []
		return place(winner, winner, path)
	}

	/** Every name a directory holds, put where the tree now says it goes. */
	const adopt = async (row: Node): Promise<Landed[]> => {
		if (!holdsRows(row)) return []
		const out: Landed[] = []
		for (const name of [...(tree.get(row.id)?.keys() ?? [])])
			out.push(...(await promote(row.id, name)))
		return out
	}

	/**
	 * Record what the disk holds now. Deferred to the end of a batch on purpose:
	 * adding, removing or renaming an entry bumps a DIRECTORY's mtime, and a
	 * directory row nobody wrote must not turn up in the feed for it — which is
	 * what the next scan would do if it found a state no one had taken down.
	 */
	const observe = async (placed: Landed[], dirs: Set<NodeId>): Promise<void> => {
		// A directory's own stamp is the last word on it: adding, renaming or removing an
		// entry moves its mtime AFTER the placement that stated it, so a directory this
		// pass put is stated again now that everything going inside it has landed. One
		// path, one owner here too — a later placement may have taken the path an
		// earlier one landed at. A directory nobody wrote keeps the mtime the disk gave
		// it: this store claimed nothing about it.
		const held = new Map<string, NodeId>(placed.map((landed) => [landed.path, landed.id]))
		for (const landed of placed) {
			if (held.get(landed.path) !== landed.id) continue
			const row = byId.get(landed.id)
			if (row && !row.deleted && isDir(row)) await meta(abs(landed.path), row)
		}
		const where = new Map<NodeId, Landed>(placed.map((landed) => [landed.id, landed]))
		for (const id of dirs) {
			const at = seen.get(id)
			if (at && !where.has(id)) where.set(id, { id, path: at.path, hash: at.hash })
		}
		for (const [id, landed] of where) {
			const s = await lstat(abs(landed.path))
			if (s === null) unmark(id)
			else mark(id, { path: landed.path, ino: String(s.ino), state: stateOf(s), hash: landed.hash })
		}
	}

	// ── The scan: where a change nobody announced becomes a row ──────────────────

	const hashOf = async (os: string): Promise<Hash | null> => {
		const data = await readFile(os).catch(() => null)
		return data === null ? null : sha256Hex(data)
	}

	/** The row a file states it is. Everything POSIX knows about it, and nothing else. */
	const derive = async (path: string, s: BigIntStats, base: NewNode): Promise<Node | null> => {
		const kind = kindOf(s)
		const row: Node = {
			id: base.id,
			parent: base.parent,
			name: base.name,
			// `mount` is the one type POSIX cannot state: on the disk a junction is the
			// directory standing in for the store it is bound to, so `kindOf` can only
			// ever call it a directory, and the sidecar is the only thing that knows
			// better. A stat that re-typed it would publish a change nobody made to
			// every replica, and open the junction to rows from this store. It stops
			// being one when it stops being directory-shaped at all.
			type: base.type === 'mount' && kind === 'dir' ? 'mount' : kind,
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
	 * Reconcile ONE entry against the row that owns it. `owner` answers first: a
	 * file belongs to the row it was materialized for, whatever the tree says about
	 * that name — which is what keeps a scan from adopting one file twice under two
	 * ids. A name no row holds is a node this store has never seen, and gets an id.
	 */
	const syncPath = async (dir: NodeId, name: string, path: string): Promise<Node | null> => {
		const s = await lstat(abs(path))
		if (s === null) return null // it vanished between the listing and the look
		const held = owner.get(path)
		const row = (held === undefined ? null : byId.get(held)) ?? lookup(dir, name)
		const at = row ? seen.get(row.id) : undefined
		if (row && at && at.path === path && unchanged(at, s)) return row
		const base: NewNode = row ?? { id: crypto.randomUUID(), parent: dir, name }
		const derived = await derive(path, s, base)
		if (derived === null) return row // unreadable: leave the row alone, and try again next scan
		write(derived)
		mark(derived.id, { path, ino: String(s.ino), state: stateOf(s), hash: derived.content })
		// A directory replaced out of band by a file or a symlink. Nothing lists its
		// entries any more, and no walk goes through a row that is not a directory, so
		// what it held is buried here or nowhere.
		if (row && isDir(row) && !isDir(derived)) buryUnder(path)
		// And the other way: a name that has become a directory is a place for rows
		// that had none, whose own pages are long behind the engine's cursor.
		if (holdsRows(derived) && !(row && isDir(row))) stale.add(derived.id)
		changed = true
		return derived
	}

	/**
	 * Reconcile ONE directory: every entry it lists, and every live row that claims
	 * a name it no longer lists. Local by construction — a directory it cannot read
	 * is left alone rather than buried, and nothing outside it is judged.
	 *
	 * Returns the directories underneath, for a caller that wants to walk on.
	 */
	const syncDir = async (id: NodeId, path: string): Promise<Landed[]> => {
		const names = await readdir(abs(path)).catch(() => null)
		if (names === null) return []
		const found = new Set(names)
		const under: Landed[] = []
		for (const name of names) {
			if (path === '' && name === SIDECAR) continue
			const row = await syncPath(id, name, path === '' ? name : `${path}/${name}`)
			if (row && holdsRows(row))
				under.push({ id: row.id, path: path === '' ? name : `${path}/${name}` })
		}
		// A name this directory used to hold and no longer does. Only a row whose file
		// WAS here counts: one that was never materialized, or whose file is parked in
		// the holding area, was never this directory's to lose.
		const gone = new Set(namesIn(id).filter((name) => !found.has(name)))
		if (gone.size > 0) bury(path, gone)
		return under
	}

	/**
	 * Names a directory no longer lists, and everything that was under them: a
	 * directory cannot be removed while its entries are there, so a name that
	 * vanished took its whole materialized subtree with it. One pass, whatever the
	 * size of the deletion.
	 */
	const bury = (path: string, gone: Set<string>): void => {
		const under = path === '' ? '' : `${path}/`
		for (const [id, at] of [...seen]) {
			if (!at.path.startsWith(under)) continue
			const [step] = at.path.slice(under.length).split('/')
			if (step === undefined || !gone.has(step)) continue
			entomb(id)
		}
	}

	/** Everything materialized UNDER a path — the row AT it left alone. */
	const buryUnder = (path: string): void => {
		const under = `${path}/`
		for (const [id, at] of [...seen]) if (at.path.startsWith(under)) entomb(id)
	}

	/** One row the disk no longer holds: not ours to track any more, and not alive. */
	const entomb = (id: NodeId): void => {
		unmark(id)
		const row = byId.get(id)
		if (!row || row.deleted) return
		write({ ...row, deleted: true, version: mint() })
		// The name it held is free, and a live row may have been waiting for it.
		stale.add(row.parent)
		changed = true
	}

	/**
	 * Directories the scan changed the answer for: a name was freed by a deletion
	 * made outside, or a name became a directory that was not one. The rows waiting on
	 * that answer have no other event coming — no page will offer them again — so the
	 * pass that found it is the pass that puts them on the disk.
	 */
	const stale = new Set<NodeId>()

	const rescue = async (): Promise<void> => {
		if (stale.size === 0) return
		const again = [...stale]
		stale.clear()
		const placed: Landed[] = []
		for (const id of again) {
			const row = byId.get(id)
			if (row && !row.deleted) placed.push(...(await adopt(row)))
		}
		if (placed.length === 0) return
		// The store made this change itself, so what it moved is taken down rather than
		// reported: the file, and the directory a rename into it bumped.
		const dirs = new Set<NodeId>()
		for (const landed of placed) {
			const row = byId.get(landed.id)
			if (row) dirs.add(row.parent)
		}
		await observe(placed, dirs)
		changed = true
	}

	/** Did the last reconcile write anything? The sidecar is saved only if it did. */
	let changed = false

	/** The one row no directory lists: root's own state. */
	const syncRoot = async (): Promise<void> => {
		const s = await lstat(root)
		const held = byId.get(ROOT)
		if (s === null || !held) return
		const at = seen.get(ROOT)
		if (at && unchanged(at, s)) return
		const derived = await derive('', s, held)
		if (!derived) return
		write(derived)
		mark(ROOT, { path: '', ino: String(s.ino), state: stateOf(s) })
		changed = true
	}

	/**
	 * The whole tree, one directory at a time, and every file in it. What a store
	 * with no watcher does, what every store does on open and if its watcher is ever
	 * lost, and what the deep pass is: anything may have written, created or removed
	 * a file, and looking is the only way to know.
	 */
	const scanAll = async (): Promise<void> => {
		changed = false
		await syncRoot()
		if (!byId.has(ROOT)) return
		const queue: Landed[] = [{ id: ROOT, path: '' }]
		for (let dir = queue.pop(); dir !== undefined; dir = queue.pop())
			queue.push(...(await syncDir(dir.id, dir.path)))
		swept = Date.now()
		deepened = swept
		await rescue()
		if (changed) await save()
	}

	/**
	 * The cheap look: stat the DIRECTORIES, and read only the ones whose own state
	 * moved. Every create, delete and rename shows up here — including an editor's
	 * atomic save, which is a rename — for about one percent of a walk. An in-place
	 * write moves no directory, so only the deep pass finds one the watcher dropped.
	 */
	const sweep = async (): Promise<void> => {
		changed = false
		await syncRoot()
		for (const [id, at] of [...seen]) {
			const row = byId.get(id)
			if (!row || row.deleted || !holdsRows(row)) continue
			const s = await lstat(abs(at.path))
			if (s === null || unchanged(at, s)) continue // gone is the parent's listing to notice
			if (id !== ROOT) await syncPath(row.parent, row.name, at.path) // the directory's own row
			await syncDir(id, at.path) // and what it lists now
		}
		swept = Date.now()
		await rescue()
		if (changed) await save()
	}

	/**
	 * One path the OS says may have moved, and nothing else. The parent's listing is
	 * what decides existence, so the entry is looked up there: gone from it means
	 * gone, and a name it holds is reconciled on its own. A directory is then walked,
	 * because one event can stand for a whole subtree that arrived at once.
	 */
	const syncAt = async (path: string): Promise<void> => {
		if (path === '') return syncRoot()
		// The nearest ancestor this index knows. An event may name a path several
		// levels below anything the store has heard of — a subtree copied in at once —
		// and it may spell a name in a normalization the rows do not use, in which case
		// the ancestor's own listing is what gets it right.
		let up = parentOf(path)
		for (let step = 0; up !== '' && owner.get(up) === undefined; step++) {
			if (step > 64) return
			path = up
			up = parentOf(up)
		}
		const dir = up === '' ? ROOT : owner.get(up)
		const parent = dir === undefined ? null : byId.get(dir)
		if (dir === undefined || !parent || parent.deleted) return
		if (!holdsRows(parent)) return
		const name = up === '' ? path : path.slice(up.length + 1)
		if (up === '' && name === SIDECAR) return // this store's own bookkeeping

		if ((await lstat(abs(path))) === null) {
			bury(up, new Set([name]))
			return
		}
		const row = await syncPath(dir, name, path)
		if (!row || !holdsRows(row)) return
		const queue: Landed[] = [{ id: row.id, path }]
		for (let at = queue.pop(); at !== undefined; at = queue.pop())
			queue.push(...(await syncDir(at.id, at.path)))
	}

	/**
	 * Look where there is reason to, in three tiers: the paths the watcher named, on
	 * every call; the directories, on the cheap floor; every file, on the deep one.
	 * This is `since`'s first act, because on a real filesystem the feed cannot be a
	 * record of commits.
	 */
	const reconcile = async (): Promise<void> => {
		if (!armed) {
			armed = true
			// The first `since` is where a watcher starts earning its keep: nothing
			// else polls. Armed BEFORE the walk that follows, or a change that lands
			// while the walk runs is in neither what it read nor what it will be told.
			arm()
			if (watching) return scanAll()
		}
		if (dirty.size > 0) await drain()
		const now = Date.now()
		// No watcher, so the walk is the only thing that ever reports: it runs on the
		// cheap floor rather than the deep one.
		if (!watching) return now - swept < SWEEP_MS ? undefined : scanAll()
		if (now - deepened >= DEEP_MS) return scanAll()
		if (now - swept >= SWEEP_MS) return sweep()
	}

	/**
	 * A few names, reconciled against the disk on their own. What a commit does before
	 * it checks a guard: whatever a local tool has done to those names is a row of this
	 * store's — a create with its own id, or a new version — BEFORE anything is judged
	 * or written over, so a guard answers about the tree that is there and bytes nobody
	 * published are never renamed away.
	 */
	const settle = async (touched: Iterable<[NodeId, string]>): Promise<void> => {
		changed = false
		for (const [parent, name] of touched) {
			const path = pathUnder(parent, name)
			if (path === null) continue
			// Gone is a change too, and the one a stale read-modify-write must not miss: a
			// name whose file a local tool deleted or renamed away is a tombstone, so the
			// version guard over it fails instead of quietly writing the file back.
			if ((await lstat(abs(path))) === null) bury(parentOf(path), new Set([name]))
			else await syncPath(parent, name, path)
		}
		if (changed) await save()
	}

	/** The paths the watcher named. O(what changed), which is the point of having one. */
	const drain = async (): Promise<void> => {
		// A directory before what is inside it, so a subtree that arrived at once is
		// adopted from the top; and the parent of every path, because adding or
		// removing an entry is a change to the DIRECTORY's own row as well.
		const paths = new Set<string>()
		for (const path of dirty) {
			paths.add(path)
			paths.add(parentOf(path))
		}
		dirty.clear()
		changed = false
		for (const path of [...paths].sort()) await syncAt(path)
		await rescue()
		if (changed) await save()
	}

	// ── The watcher: the OS says where to look ───────────────────────────────────

	/** Paths the OS says may have changed. Drained by `since`, never trusted. */
	const dirty = new Set<string>()
	let watcher: FSWatcher | null = null
	/** Has a watcher been asked for yet? Only the first `since` asks. */
	let armed = false
	/** Is one listening? False means the walk is the only thing that reports. */
	let watching = false
	/** When the last cheap look and the last deep one finished. */
	let swept = 0
	let deepened = 0

	/**
	 * Arm the OS. An event is a HINT and nothing more: macOS calls an in-place write
	 * a rename and names ancestors beside the leaf, and any platform may coalesce or
	 * drop under load. So the type is ignored, the name only says where to look, and
	 * losing the watcher costs a walk rather than correctness.
	 *
	 * `persistent: false` on purpose: a CLI that never closes the store still exits,
	 * because a watcher nothing is waiting on does not hold the loop open. It keeps
	 * delivering while the process has other work.
	 */
	const arm = (): void => {
		try {
			const held = watch(root, { recursive: true, persistent: false }, (_type, name) => {
				if (name === null) {
					lost()
					return
				}
				dirty.add(String(name).split(sep).join('/'))
			})
			held.on('error', lost)
			watcher = held
			watching = true
		} catch {
			// No watcher on this platform, this filesystem, or past this many watches
			// (Linux counts them per directory). The tree gets walked instead.
			watching = false
		}
	}

	/**
	 * The watcher is gone or said something it could not name. Whatever it missed is
	 * only findable by looking, so from here on the walk carries it alone — on the
	 * cheap floor, since nothing else will report an in-place write.
	 */
	const lost = (): void => {
		watcher?.close()
		watcher = null
		watching = false
		dirty.clear()
		swept = 0
	}

	// ── Content: the files themselves ────────────────────────────────────────────

	/** Where bytes wait while no row names them yet. Null for a key that is no hash. */
	const spill = (hash: Hash): string | null => (HASH.test(hash) ? join(root, SPILL, hash) : null)

	/**
	 * The file that holds these bytes: a row that names the hash, while the disk
	 * still holds what this store last observed there.
	 */
	const fileFor = async (hash: Hash): Promise<string | null> => {
		for (const id of holders.get(hash) ?? []) {
			const at = seen.get(id)
			if (!at) continue
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

	/**
	 * Bytes for a hash a row already names but whose file does not hold yet — a
	 * stub materialized before its content arrived. The file IS the data here, so
	 * a `put` is the only chance it gets: `hydratingBlobs` puts and never commits,
	 * and without this a store read would answer while `cat` kept showing an empty
	 * file. A walk of the rows, because a stub is rare and an index for one would
	 * be a fourth thing to keep in step.
	 */
	const hydrate = async (hash: Hash, data: Uint8Array): Promise<boolean> => {
		const placed: Landed[] = []
		const dirs = new Set<NodeId>()
		for (const row of [...byId.values()]) {
			if (row.deleted || row.content !== hash) continue
			const at = seen.get(row.id)
			if (!at || at.hash === hash) continue
			await publish(abs(at.path), (tmp) => writeFile(tmp, data))
			await meta(abs(at.path), row)
			placed.push({ id: row.id, path: at.path, hash })
			dirs.add(row.parent)
		}
		if (placed.length === 0) return false
		// The row said this all along, so nothing about it changed: only what the disk
		// holds did — the file, and the directory a publish renames into.
		await observe(placed, dirs)
		return true
	}

	// ── Opening ──────────────────────────────────────────────────────────────────

	const start = async (): Promise<void> => {
		// Creates the tree itself when it is not there — and BEFORE root's state is
		// taken down, so the sidecar's own arrival is not a change to it.
		await mkdir(join(root, SPILL), { recursive: true })
		const loaded = await load()
		if (!loaded) {
			lineage = crypto.randomUUID() // rule 11: a fresh sidecar is a fresh lineage
			const s = await lstat(root)
			const seed = s === null ? null : await derive('', s, { id: ROOT, parent: ROOT, name: '' })
			// Rule 6: the root row, and the one row whose id is not minted here.
			if (s === null || seed === null) throw new Error(`fsStore: cannot read ${root}`)
			write(seed)
			mark(ROOT, { path: '', ino: String(s.ino), state: stateOf(s) })
		}
		// The watcher is not armed here: the first `since` does that, so a consumer
		// that only reads and writes never asks the OS for one at all — and a CLI that
		// never closes the store has nothing to leak.
		// The index is rebuilt against the tree on open, so a path resolves the
		// moment the store is there — a consumer does not have to poll first.
		await scanAll()
		// A lineage nobody else can read is a lineage that fences every cursor this
		// instance hands out, so a fresh sidecar is saved even when the tree it
		// describes is empty and the scan found nothing to say.
		if (!loaded && !changed) await save()
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
			// One row per name, in one stable name order, and only the names of THIS
			// directory: the cursor is the last name emitted, so a duplicate resolves
			// to its winner and a resumed listing neither skips nor repeats.
			const nodes: Node[] = []
			let last = cursor
			let more = false
			for (const name of namesIn(parent)) {
				if (last !== undefined && name <= last) continue
				if (nodes.length === PAGE) {
					more = true
					break
				}
				const row = lookup(parent, name)
				if (row) nodes.push(copy(row))
				last = name
			}
			return more && last !== undefined ? { nodes, next: last } : { nodes }
		},

		async since(cursor) {
			await open()
			const from = position(cursor) // rule 11, before any work: a fenced cursor buys no scan
			await serial(reconcile)
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
				// What this batch is about to touch, looked at on the DISK first: the names
				// it takes, and the names its guards ask about. A guard answered from an
				// index that has not looked since the last poll is answered about a tree
				// that may no longer exist — a `free` name a local tool has taken passes,
				// and the placement then renames over bytes nobody ever published. Only
				// these paths, because a commit is not a scan: one `lstat` each, and a name
				// this store already accounts for costs nothing more.
				const touched = new Map<string, [NodeId, string]>()
				const touch = (parent: NodeId, name: string): void =>
					void touched.set(parent + SEP + name, [parent, name])
				for (const row of batch) if (!row.deleted) touch(row.parent, row.name)
				for (const guard of checks ?? []) {
					if ('free' in guard) touch(guard.free.parent, guard.free.name)
					else {
						const held = byId.get(guard.version.id)
						if (held && !held.deleted) touch(held.parent, held.name)
					}
				}
				await settle(touched.values())

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

				// Then ONE order for the disk, because the disk has one: a directory has
				// to be at its new name before a child goes into it, and empty before it
				// goes itself. Depth does both — what lands, shallowest first; what goes,
				// deepest first — and the contract does not order a commit inside itself,
				// so the store is free to choose.
				const steps = todo.map(({ row, old, fresh }) => ({
					row,
					old,
					fresh,
					path: row.deleted ? (seen.get(row.id)?.path ?? null) : pathOf(row)
				}))
				const deep = (a: { path: string | null }): number => a.path?.split('/').length ?? 0
				const ordered = [
					...steps.filter((step) => step.row.deleted).sort((a, b) => deep(b) - deep(a)),
					...steps.filter((step) => !step.row.deleted).sort((a, b) => deep(a) - deep(b))
				]

				const placed: Landed[] = []
				const dirs = new Set<NodeId>()
				for (const { row, old, path } of ordered) {
					placed.push(...(await place(row, old, path)))
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
		// tells no one, and only a look finds it. Polling `since` looks.

		/**
		 * The watcher, and nothing else: every commit and every reconcile saves the
		 * sidecar before it returns, so there is no state here that outlives this
		 * call. The store keeps answering afterwards, by walking the tree instead of
		 * being told about it — but a caller that meant to be done should behave as
		 * though it is.
		 */
		async close() {
			lost()
		},

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
				return serial(async () => {
					// A row that was waiting for these bytes takes them into its own file,
					// which is where content lives here. Then the spill has nothing to keep.
					const filled = await hydrate(hash, held)
					if (filled) return save()
					if ((await lstat(waiting)) === null && (await fileFor(hash)) === null)
						await publish(waiting, (tmp) => writeFile(tmp, held))
				})
			}
		}
	}
}

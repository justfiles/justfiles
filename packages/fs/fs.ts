/**
 * A `Store` over a real directory. The files themselves are the data — `cat`, `git` and
 * `just` see exactly what the volume sees — and a sidecar beside them holds what POSIX
 * has no place for: node ids, versions, xattrs, the feed order, and the state each row's
 * file was last seen in. The disk is reached through `Disk` and nowhere else, so this
 * file names no path and calls no syscall.
 *
 * ## What it assumes, and what it does not
 *
 * This store OWNS the tree it is given, and runs as somebody who can read and write it.
 * Inside that it defends against concurrent change — a local tool may create, edit, move
 * or delete anything at any moment, including between this store's own two calls, and
 * what was observed is checked again before it is acted on — and against a row from a
 * peer naming anything outside the tree.
 *
 * That defence is a check next to the act, never one call. POSIX offers no rename, write
 * or chmod conditional on what the name currently holds, so every one of them is
 * check-then-act, and a local tool writing between the two still wins. What the checks
 * buy is a window of adjacent syscalls instead of one spanning a whole batch — and, where
 * a claim would outlive the window, silence: nothing is recorded rather than something
 * that would read as reconciled and stop the scan ever looking again.
 *
 * Outside it: it does not work around a mode that shuts it out of a LOOK. A directory it
 * cannot list is skipped and its rows keep the last state it saw, which is rsync's
 * answer; a WRITE is the one exception, because the page carrying it would otherwise be
 * retried for ever. It does not adopt what POSIX has and a row cannot say — a FIFO, a
 * socket, a device node — and does not read one either: those names are left where they
 * are, untouched and unreported. It does not defend against a tree whose owner is hostile to it: a
 * `.jfs` an attacker can write is a store an attacker controls. And it has no
 * transaction, so a commit that FAILS halfway leaves the batch half applied and the
 * sidecar unsaved — the next scan reconciles what it can see, and a retry heals the rest.
 *
 * A finding outside this envelope is a change to the envelope, and belongs here before it
 * belongs in the code.
 *
 * Two rules carry the weight, and every case below is one of them:
 *
 * - **One path, one owner.** `seen` says where a row's file is; `owner` says whose file a
 *   path is. A scan asks `owner` before it asks the tree, so a file is never adopted
 *   twice under two ids. When two live rows claim one name (rule 1), the disk holds the
 *   lowest id, because a local tool reading that path must see what the store answers.
 * - **A live row with no path keeps its bytes.** Visibility is reachability (rule 9), and
 *   a row with no path is still live — its file the only copy of its content. It moves to
 *   a holding area inside the sidecar, where the scan never looks and `blobs` still can;
 *   whatever later makes the row reachable renames it back.
 *
 * Content IS the file: `blobs` answers a hash from the file of a row that names it, and
 * only bytes no row has adopted yet get a home of their own (`.jfs/blobs`). The sidecar
 * is rewritten whole on every change and a scan hashes every changed file — this serves a
 * working tree, not a warehouse.
 */

import type { BigIntStats } from 'node:fs'
import {
	AT_ROOT,
	type Disk,
	fsDisk,
	SEARCH,
	type Seen,
	type Spot,
	type Step,
	spot,
	stateOf,
	unchanged,
	under,
	up,
	WRITE
} from './disk'
import { versions } from './engine'
import { decodeNode, encodeNode, type WireNode } from './http'
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

/** Rows per page. Big enough to list a normal directory in one page. */
const PAGE = 128

/** NUL — the one byte a name can never hold, so composed keys never collide. */
const SEP = String.fromCharCode(0)

/**
 * The sidecar: one directory, so a local tool sees one thing it must leave alone. Names
 * rather than paths — each reaches the disk through `under`, like any other name.
 */
const SIDECAR = '.jfs'
const INDEX = 'index.json'
const SPILL = 'blobs'
/** Where the file of a row the tree cannot reach waits for a place in it. */
const HOLD = 'detached'

/** What a `Hash` is: 64 hex characters. A name for content, never a path. */
const HASH = /^[0-9a-f]{64}$/

/**
 * How long between looks. Cheap ones: one `lstat` per DIRECTORY, whose mtime moves on
 * every structural change, for about one percent of a walk. Without a floor, a consumer
 * polling `since` every few tens of milliseconds would walk the tree back to back.
 */
export const SWEEP_MS = 1_000

/**
 * How long between the deep looks: one `lstat` per FILE, the only thing that finds an
 * in-place write nobody announced. Rare, because a watcher usually reports those in
 * milliseconds — and kept, because a recursive `fs.watch` DROPS events (measured on
 * macOS, a process holding a few dozen watchers loses them outright).
 */
const DEEP_MS = 5_000

const EMPTY = new Uint8Array()

/**
 * Where a row was just put, for the observation pass at the end of a batch. `was` is what
 * the placement left at the name: held to in full for anything the rest of the batch has
 * no business moving, and by its identity alone for a directory, whose mtime an entry
 * landing inside it moves on purpose — which is why the observation is deferred at all.
 */
type Landed = { id: NodeId; path: Spot; hash?: Hash; was?: Seen }

/** All a node needs before the disk says what it is: an id and a place in the tree. */
type NewNode = Pick<Node, 'id' | 'parent' | 'name'> & Partial<Node>

type Entry = { node: WireNode; at: number; seen?: Seen }
type Sidecar = { lineage: string; seq: number; entries: Entry[] }

/**
 * The same row again, whatever version a fresh look would mint for it. A new version for
 * an identical row is change-feed traffic nobody can act on.
 */
const restated = (was: Node, now: Node): boolean => same(was, { ...now, version: was.version })

/**
 * What a row states about its object, for the disk to put on it. A file that arrives with
 * `writeFile`'s mode and this moment's stamp is not the one the row describes.
 */
const stampOf = (row: Node) => ({
	mode: row.mode,
	mtimeNs: row.mtimeNs,
	symlink: row.type === 'symlink'
})

/**
 * Is what the disk holds this backend's own rounding of the stamp a row states? A `Date`
 * carries milliseconds, so that is all `stamp` can write — and a filesystem may store even
 * that a few nanoseconds off, which is why this asks how FAR apart they are rather than
 * which millisecond each falls in.
 */
const rounded = (disk: bigint, stated: bigint): boolean => {
	const written = (stated / 1_000_000n) * 1_000_000n
	return (disk > written ? disk - written : written - disk) < 1_000_000n
}

/**
 * What POSIX says this is, in the vocabulary a row has — and null for everything else: a
 * FIFO, a socket, a device node. Not a row this store can state, and not one it may even
 * LOOK at: opening a FIFO blocks until somebody writes to it, and the hash of every
 * changed file is taken on the one turn the whole store shares. One named pipe in the
 * tree would take the store with it.
 */
const kindOf = (s: BigIntStats): Node['type'] | null =>
	s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'symlink' : s.isFile() ? 'file' : null

/** Does this row hold entries on the disk? A mount stands where a directory would. */
const isDir = (row: Node): boolean => row.type === 'dir' || row.type === 'mount'

/**
 * Can rows of THIS store live under it? Only a directory can. A mount’s children live in
 * the store it is bound to, which is the boundary `authority.ts` refuses a commit over;
 * this is the same rule on the disk.
 */
const holdsRows = (row: Node): boolean => row.type === 'dir'

/**
 * An id as ONE path component. `encodeURIComponent` takes the separators out, and the
 * prefix is what makes it total: no encoding of any id is `.` or `..`.
 */
const own = (id: NodeId): string => `id-${encodeURIComponent(id)}`

export type FsStoreOptions = {
	/** The disk to reach the tree through. Defaults to the real one, rooted at `root`. */
	disk?: Disk
	/** The version source for changes found on disk. Defaults to a private fs author. */
	mintVersion?: () => Version
	/**
	 * Root-level names another store is joined at (T15's bindings, as this backend sees
	 * them). Their directories are left exactly as they are: not listed, not adopted,
	 * not reported — so `<root>/private` can be a real folder in Finder that this store
	 * never puts on any wire.
	 */
	mounts?: Iterable<string>
}

export function fsStore(root: string, opts: FsStoreOptions = {}): Store {
	const disk = opts.disk ?? fsDisk(root)
	/**
	 * Root-level names this store does not own, and therefore never imports: its own
	 * sidecar, and every name the host has joined another store at.
	 *
	 * A mount is what keeps local data out of a synced store, and on this backend the
	 * mounted store's tree is a REAL directory a user can open in Finder — so the
	 * boundary has to be something the bridge can see, and the design puts exactly this
	 * filter here ("an import filter private to the native bridge: the bridge never
	 * commits matching observations"). It is one name per binding, out of the host's own
	 * fstab, not a pattern language: nothing here matches, and a name that is not bound
	 * is ordinary data.
	 */
	const foreign = new Set<string>([SIDECAR, ...(opts.mounts ?? [])])
	const byId = new Map<NodeId, Node>()
	/**
	 * parent → name → ids, live rows only. One index for both jobs the tree has: the
	 * `(parent, name)` lookup, and the listing of a directory.
	 */
	const tree = new Map<NodeId, Map<string, Set<NodeId>>>()
	// The feed, and no journal behind it: a Map iterates in insertion order, so
	// re-inserting a row on every write moves it to the end of the order.
	const order = new Map<NodeId, number>()
	/** id → where its file is, and what that file held when this store last looked. */
	const seen = new Map<NodeId, Seen>()
	/** path → the row whose file sits there. One path, one owner. */
	const owner = new Map<Spot, NodeId>()
	/** hash → the rows whose file holds those bytes: the content map, read backwards. */
	const holders = new Map<Hash, Set<NodeId>>()
	let lineage = ''
	let next = 0
	/** The author tag of every version the scan mints. Nothing else writes one. */
	const mint = opts.mintVersion ?? versions(`fs:${crypto.randomUUID()}`)

	/**
	 * This store's own corner of the tree, built through `under` like every other name.
	 * Non-null by construction, so the check is stated once here rather than at each use.
	 */
	const side = under(AT_ROOT, SIDECAR)
	if (side === null) throw new Error('fsStore: the sidecar has no name')
	const index = under(side, INDEX)
	const spilled = under(side, SPILL)
	const held = under(side, HOLD)
	if (index === null || spilled === null || held === null)
		throw new Error('fsStore: the sidecar has no name')

	/**
	 * One thing at a time. A scan and a commit both walk the disk against the
	 * index, so two of them at once would mint a second id for one file, or
	 * tombstone a row whose file is still being written.
	 */
	let tail: Promise<unknown> = Promise.resolve()
	const serial = <T>(work: () => Promise<T>): Promise<T> => {
		// And what a turn opened, the turn closes — including for a pass leaving by way of a
		// throw, whose directories would otherwise stay open until some later pass ran, and
		// there may not be one. Passes still relock where they need the ORDER; this catches
		// the way out.
		const run = tail.then(async () => {
			try {
				return await work()
			} finally {
				await relock()
			}
		})
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
	 * Where a row belongs in the tree, or null when it has no place on the disk: nothing can
	 * reach it from root (rule 9), or the name it asks for is the sidecar’s. Either way its
	 * file goes to the holding area instead.
	 *
	 * Rule 1 is asked at every step rather than only of the row: a name belongs to the lowest
	 * id that claims it, so everything under a duplicate that lost is unreachable too.
	 */
	const pathOf = (row: Node): Spot | null => {
		const names: string[] = []
		const walked = new Set<NodeId>()
		let at = row
		while (at.id !== ROOT) {
			if (walked.has(at.id)) return null
			walked.add(at.id)
			names.unshift(at.name)
			// The name has to be this row's to have (rule 1): otherwise two rows in ONE batch write
			// over each other’s file, and the second `rename` onto what the first left fails and
			// wedges the page for good.
			if (lookup(at.parent, at.name)?.id !== at.id) return null
			const up = byId.get(at.parent)
			// Missing, buried, or not a directory at all: a page may re-type a file into this row’s
			// directory and arrive AFTER the rows that fill it, and writing under a file would fail
			// with ENOTDIR and wedge the replica on that page.
			if (!up || up.deleted || !holdsRows(up)) return null
			at = up
		}
		if (names[0] !== undefined && foreign.has(names[0])) return null
		// Down from root, ONE name at a time: a row from a peer carrying `..`, a separator or a
		// NUL simply has nowhere to be.
		let spot = AT_ROOT
		for (const name of names) {
			const down = under(spot, name)
			if (down === null) return null
			spot = down
		}
		return spot
	}

	/**
	 * The path a `(parent, name)` would resolve to — `pathOf`’s question, asked of a name no
	 * row may hold yet. Null when the parent has no path of its own.
	 */
	const pathUnder = (parent: NodeId, name: string): Spot | null => {
		if (parent === ROOT) return foreign.has(name) ? null : under(AT_ROOT, name)
		const up = byId.get(parent)
		if (!up || up.deleted || !holdsRows(up)) return null
		const dir = pathOf(up)
		return dir === null ? null : under(dir, name)
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
	 * Would a recursive `rm` at this path take a file this store still tracks? What is under
	 * a directory may belong to rows nobody deleted, and their files are the only copy of
	 * their bytes there is. `was` is what the disk holds there, when the caller knows.
	 */
	/**
	 * Everything under a directory this batch is about to take off the disk, looked at
	 * first. A commit is not a scan, but a recursive removal is the one act that cannot be
	 * taken back: a file a local tool made since the last look is in nobody's index, so
	 * `holdsFiles` would call the directory empty and `rm -rf` the only copy of it.
	 *
	 * Looking makes it a row — of the buried directory, so it has no path and its bytes go
	 * to the holding area with the subtree, and onto the feed for every other replica.
	 */
	const lookUnder = async (id: NodeId, path: Spot): Promise<void> => {
		const queue: Landed[] = [{ id, path }]
		for (let dir = queue.pop(); dir !== undefined; dir = queue.pop())
			queue.push(...(await syncDir(dir.id, dir.path)))
	}

	/**
	 * Is there anything under this that must not go with it? What this store tracks, and
	 * whatever a directory it cannot list may be holding — not knowing is reason enough to
	 * move it aside rather than remove it.
	 */
	const keepsAnything = async (path: Spot, was: Node | null): Promise<boolean> => {
		if (was && !isDir(was)) return false
		return holdsFiles(path, was) || (await disk.list(path)) === null
	}

	const holdsFiles = (path: Spot, was: Node | null = null): boolean => {
		if (was && !isDir(was)) return false
		const under = `${path}/`
		for (const at of seen.values()) if (at.path.startsWith(under)) return true
		return false
	}

	/**
	 * A directory moved, so every path under it moved with it. The tails are already checked
	 * and unchanged by the move, so they are carried over rather than walked again.
	 */
	const moveSeen = (from: Spot, to: Spot): void => {
		const under = `${from}/`
		for (const [id, at] of [...seen]) {
			if (at.path === from) mark(id, { ...at, path: to })
			else if (at.path.startsWith(under))
				mark(id, { ...at, path: (to + at.path.slice(from.length)) as Spot })
		}
	}

	// ── The sidecar ──────────────────────────────────────────────────────────────

	const load = async (): Promise<boolean> => {
		// "It is not there" is the only answer that means a directory with no history. Anything
		// else — no permission, a device that stopped answering — must never be taken for a
		// fresh tree: that mints a new lineage, rebinds every id, and then `save` renames the
		// new index over the one that could not be read.
		const raw = await disk.bytes(index, true)
		if (raw === null) return false
		const sidecar = JSON.parse(new TextDecoder().decode(raw)) as Sidecar
		lineage = sidecar.lineage
		next = sidecar.seq
		// Written in feed order, so the order Map is rebuilt by reading it through.
		for (const entry of sidecar.entries) {
			const row = decodeNode(entry.node)
			byId.set(row.id, row)
			if (!row.deleted) link(row)
			order.set(row.id, entry.at)
			// A path out of a FILE, checked again on the way back in: this was last a string in a
			// document any local tool can edit, and it is what `rename` and `rm` are aimed at. An
			// entry that no longer names somewhere inside the tree is dropped; the row stays, and
			// the next scan finds its file the way it finds any other.
			const at = entry.seen === undefined ? null : spot(entry.seen.path)
			if (entry.seen && at !== null) mark(row.id, { ...entry.seen, path: at })
		}
		return true
	}

	/**
	 * The whole index, published under a private name and renamed over the old one — a
	 * half-written sidecar would lose every id in the tree. A crash before the rename loses
	 * the ids minted since the last save, and the next scan mints new ones.
	 */
	const save = async (): Promise<void> => {
		const entries: Entry[] = []
		for (const [id, at] of order) {
			const node = byId.get(id)
			if (node) entries.push({ node: encodeNode(node), at, seen: seen.get(id) })
		}
		const sidecar: Sidecar = { lineage, seq: next, entries }
		// The index lives INSIDE the tree it describes, so writing it needs a way in like
		// anything else: root's own row may state a mode that shuts this store out.
		await unlockFor(side)
		try {
			// `unseen`, and it is the plainest case of one: no row names the sidecar, so there
			// is nothing this store could have observed there. Nothing records it either, so
			// its answer is dropped — a refused publish is the same loss as the crash above,
			// and the next scan mints ids again.
			await disk.write(
				index,
				new TextEncoder().encode(JSON.stringify(sidecar)),
				undefined,
				'unseen'
			)
		} finally {
			await relock()
		}
	}

	// ── The disk ─────────────────────────────────────────────────────────────────

	/**
	 * Remove what a row named, while the disk still holds THAT file — a rename inside the
	 * same batch may have put another row’s file at the path. A directory goes by `rmdir`,
	 * which refuses one holding anything; a file is unlinked while its whole state still
	 * matches. Only ever aimed at a directory this store believes empty: one with rows under
	 * it is parked, so nothing here recurses.
	 */
	const remove = async (at: Seen, was: Node | null): Promise<void> => {
		await disk.drop(at, !(was && !isDir(was)))
		// An empty container in the holding area is nobody's row, so it goes too.
		for (let box = up(at.path); box.startsWith(held); box = up(box))
			if (!(await disk.prune(box))) return
	}

	/**
	 * Does this directory’s mode withhold what a pass needs? `WRITE` to put an entry in one,
	 * `SEARCH` to reach anything underneath — and search is what every ancestor has to grant.
	 */
	const locked = (dir: Node, need: number): boolean => isDir(dir) && (dir.mode & need) !== need

	/**
	 * A directory whose stated mode shuts this store out, with an entry of its own about to
	 * land or leave: POSIX wants write and search on the PARENT, and a page carrying only the
	 * child grants neither. So every directory the index knows on the way is handed to the
	 * disk to open, and `relock` puts the stated modes back as the pass’s last act. Only the
	 * last is written IN, so only the last needs write. For that window the disk holds a mode
	 * no row states — against a page this replica could never apply, retried for ever.
	 */
	const unlockFor = async (path: Spot, needs = WRITE | SEARCH): Promise<void> => {
		const walk: Spot[] = [AT_ROOT]
		for (let at = path; at !== AT_ROOT; at = up(at)) walk.splice(1, 0, at)
		const steps: Step[] = []
		for (const step of walk) {
			const id = owner.get(step)
			const dir = id === undefined ? undefined : byId.get(id)
			const at = id === undefined ? undefined : seen.get(id)
			const need = step === path ? needs : SEARCH
			// Identity is the inode here as everywhere else: another process may have put a
			// different directory at this name, and that one is not this store's to open.
			if (id === undefined || !dir || dir.deleted || !at || !locked(dir, need)) continue
			steps.push({ id, spot: step, mode: dir.mode, ino: at.ino, need })
		}
		await disk.unlock(steps)
	}

	/** One directory this store just placed, whose identity it does not know yet. */
	const unlockNew = (row: Node, path: Spot, need: number): Promise<void> =>
		disk.unlock([{ id: row.id, spot: path, mode: row.mode, need }])

	/**
	 * The stated mode back on every directory this pass opened, and their states taken down:
	 * the chmod moved the mode and the ctime AFTER the observation pass looked, so without
	 * this the next walk reads the way this store let itself in as a change somebody made,
	 * and publishes a version of a directory nobody touched.
	 */
	const relock = async (): Promise<void> => {
		const back = await disk.relock((id) => {
			const dir = byId.get(id)
			const at = seen.get(id)
			return !dir || dir.deleted || !at ? null : { spot: at.path, ino: at.ino, mode: dir.mode }
		})
		for (const { id, state } of back) {
			const at = seen.get(id)
			if (at) mark(id, { ...at, state })
		}
	}

	/**
	 * A live row with no path of its own still owns bytes, and here they are the only copy —
	 * whether nothing can reach it, or another row holds the name it asks for. Its file
	 * leaves the namespace for the holding area, where the scan never looks and `blobs` still
	 * finds it. ONE rename, whatever the subtree under it holds.
	 */
	const park = async (id: NodeId, at: Seen): Promise<void> => {
		// The id names its place in there — ENCODED, because `..` and a separator are ordinary
		// characters in an id and a way out of the store in a path. A second name is only
		// needed when files this store still tracks are under the first, which an earlier park
		// left behind and is not this one’s to delete.
		const its = under(held, own(id))
		if (its === null) return
		if (at.path === its || at.path.startsWith(`${its}-`)) return // already in its place
		if (!(await disk.mine(at))) {
			unmark(id)
			return
		}
		const to = holdsFiles(its) ? under(held, `${own(id)}-${crypto.randomUUID()}`) : its
		if (to === null) return
		await disk.dir(held)
		await disk.clear(to)
		// A rename moves the ctime, and nothing observes a parked file afterwards — so the
		// state `blobs` will recognise the file by is the one the move itself hands back.
		// What was UNDER a renamed directory keeps its own.
		const now = await disk.move(at, to)
		if (now === null) {
			unmark(id)
			return
		}
		moveSeen(at.path, to)
		const moved = seen.get(id)
		if (moved) mark(id, { ...moved, ...now })
	}

	/**
	 * The bytes of a file row, and the hash the file ends up holding. Three cases: the file
	 * already holds what the row names, the row names bytes this store has, or it names bytes
	 * this store does not have — a lazy stub, where the name appears empty and the content
	 * fills in when it arrives, without the row moving at all.
	 */
	const fill = async (
		os: Spot,
		row: Node,
		old: Node | null,
		at: Seen | undefined
	): Promise<{ at: Seen; hash?: Hash } | null> => {
		const on = stampOf(row)
		/**
		 * Both ways in carry what this store last saw at the name, and land only while the
		 * disk still holds it. The commit looked at these names before it began, but a local
		 * tool writes on its own clock: between that look and this act it may have edited the
		 * file, and its bytes are the only copy of themselves there is.
		 *
		 * Null when it has, rather than a lost write recorded as a placement: the row's hash
		 * beside a stranger's state would read as reconciled, and the scan would skip those
		 * bytes for ever while `blobs` answered them under a key that does not name them. The
		 * row keeps no observation instead, and the next scan adopts what is really there —
		 * which is what puts the edit on the feed.
		 */
		const keep = async (hash: Hash | undefined): Promise<{ at: Seen; hash?: Hash } | null> => {
			const now = await disk.stamp(os, on, at ?? 'unseen')
			return now === null ? null : { at: now, hash }
		}
		const publish = async (
			data: Uint8Array,
			hash?: Hash
		): Promise<{ at: Seen; hash?: Hash } | null> => {
			const now = await disk.write(os, data, on, at ?? 'unseen')
			return now === null ? null : { at: now, hash }
		}
		if (row.content === undefined) {
			// No content is a claim too, so a row that dropped its hash empties its file.
			if (at && old?.content === undefined) return keep(undefined)
			return publish(EMPTY)
		}
		if (at?.hash === row.content) return keep(at.hash)
		const data = await readBlob(row.content)
		if (data !== null) return publish(data, row.content)
		if (at) return keep(at.hash) // the row is a stub over whatever the file holds
		return publish(EMPTY)
	}

	/** Put one row on the disk, at the path the tree gives it. Null when there is nothing to put. */
	const put = async (row: Node, old: Node | null, path: Spot | null): Promise<Landed | null> => {
		let at = seen.get(row.id)
		// The directory this store IS: nothing to create, move or remove. Rule 6 says root is
		// never buried, and a replica holding a tombstone for it anyway must not act on one.
		// Its mode and its stamp are as real as any other row’s.
		if (row.id === ROOT) {
			if (row.deleted) return null
			// `unseen`, and a DIRECTORY's stamp always is: anything this batch puts at the top
			// level moves root's mtime, so holding this to what was observed before the batch
			// would refuse it every time somebody added a file. The observation pass has the
			// last word on what root ends up recorded as.
			await disk.stamp(AT_ROOT, stampOf(row), 'unseen')
			return { id: ROOT, path: AT_ROOT }
		}
		if (row.deleted) {
			if (at) {
				await unlockFor(up(at.path))
				// A batch may tombstone a directory a page before the rows inside it, so what is
				// under it decides — and what is under it is looked at first, because a recursive
				// `rm` does not get to take a file nobody has ever seen.
				if (old && isDir(old)) await lookUnder(row.id, at.path)
				if (await keepsAnything(at.path, old)) await park(row.id, at)
				else await remove(at, old)
			}
			unmark(row.id)
			return null
		}
		if (path === null) {
			if (at) {
				await unlockFor(up(at.path))
				await park(row.id, at)
			}
			return null
		}

		await unlockFor(up(path))

		// The directory this row goes in, when the index does not already have it
		// THERE: a row whose parent is not on the disk at all still lands, which is how
		// a row that was parked, or one whose write failed halfway, comes back.
		if (seen.get(row.parent)?.path !== up(path)) await disk.dir(up(path))

		// Another row’s file is at this path already: a duplicate that used to hold the name, or
		// a row this same batch moves elsewhere and has not placed yet. That file is the only
		// copy of the other row’s bytes, so it is parked rather than renamed over.
		const taken = owner.get(path)
		if (taken !== undefined && taken !== row.id) {
			const was = seen.get(taken)
			if (was) {
				await park(taken, was)
				at = seen.get(row.id) // parking a directory moved whatever was under it
			}
		}

		// The row names a path other than the one its file sits at: ONE rename,
		// whatever the subtree under it holds. A parked file comes back the same way.
		if (at && at.path !== path) {
			await unlockFor(up(at.path))
			// A rename moves the ctime of what it moved, so the state carried over is already
			// out of date — and a later check would read this store's own rename as somebody
			// else's change. The move hands back the state it left, the way `park` takes it.
			const now = await disk.move(at, path)
			if (now === null) {
				// A move also refuses a name something already holds, and this store believes
				// this one is free: the commit looked at it before it began, and any row that
				// held it has just been parked. So what is there arrived since, nothing has
				// ever seen its bytes, and this file is their only copy — the write below
				// would take the name from them just as surely as the rename would. The row
				// keeps the file it has instead, untouched by the refusal, and waits: the next
				// scan adopts what is there, and two rows wanting one name is resolved the
				// ordinary way.
				if (owner.get(path) === undefined && !(await disk.absent(path))) return null
				unmark(row.id) // that file is gone, or is another row's now
				at = undefined
			} else {
				moveSeen(at.path, path)
				const moved = seen.get(row.id)
				if (moved !== undefined) mark(row.id, { ...moved, ...now })
				at = seen.get(row.id)
			}
		}
		// A file where a directory was, or the other way round: the old one goes, and goes the
		// way a tombstoned directory does — what was inside it may be live rows whose own pages
		// have not arrived yet.
		if (at && old && old.type !== row.type) {
			if (isDir(old)) await lookUnder(row.id, at.path)
			if (await keepsAnything(at.path, old)) await park(row.id, at)
			else await remove(at, old)
			unmark(row.id)
			// Both of those refuse an object that is not what this store last saw — a local
			// tool edited it since the commit looked, and those bytes are the only copy of
			// themselves. Nothing is placed over one: what the row wants here is a different
			// TYPE, so the placement would not even hold the observation that stopped the
			// removal. The next scan makes what is really there a row instead.
			if (!(await disk.absent(at.path))) return null
			at = undefined
		}

		let hash = at?.hash
		// What the placement left, observed by the one thing that made it — never looked up
		// again afterwards, which would describe whatever answers to the name by then.
		let now: Seen | null
		if (row.type === 'symlink') {
			now = await disk.link(path, row.link ?? '', stampOf(row), at ?? 'unseen')
		} else if (row.type === 'file') {
			const filled = await fill(path, row, old, at)
			now = filled === null ? null : filled.at
			if (filled !== null) hash = filled.hash
		} else {
			// A mount is a junction into another store, which reads as a directory to
			// anything local — and as an empty one until that store is bound.
			now = await disk.dir(path)
		}
		// Nothing landed, or somebody else's file is at the name. Nothing is claimed about
		// it, and the stale observation goes, so the next scan derives what is really there.
		if (now === null) {
			unmark(row.id)
			return null
		}
		// A DIRECTORY's metadata waits for the observation pass, after everything going inside
		// it has landed: an entry appearing moves its mtime anyway, and a mode that LOCKS this
		// store out would fail the child of the same batch with EACCES, stalling the replica for
		// good. A mode it can still write through goes on now — write and SEARCH is the whole
		// requirement, so `0300` is as workable as `0700`.
		if (isDir(row)) {
			// Its identity, from before the stamp and before anything lands inside it. What
			// this store does next moves its state on purpose and its inode never — so what
			// it was already observed to be is the better baseline, and what `dir` just made
			// is the baseline for a directory this pass created.
			const was = at ?? now
			// The mode is stated last, `unseen`, and its answer dropped: entries of this same
			// batch are landing inside it, so its state has moved on purpose and there is
			// nothing to hold it to. Best effort — the observation pass has the last word.
			if ((row.mode & 0o300) === 0o300) await disk.stamp(path, { mode: row.mode }, 'unseen')
			return { id: row.id, path, hash, was }
		}
		// Already stamped, by whatever put it there: a file rides in wearing what the row
		// states, so there is no moment between arriving and being described.
		return { id: row.id, path, hash, was: now }
	}

	/**
	 * A row on the disk, and the rows that may have to move because of it. Neither is in the
	 * batch and neither ever will be — the engine’s cursor is past the page that carried
	 * them, so this commit is the only chance their files get. A name this row LEFT may be
	 * claimed by a live row waiting in the holding area; a DIRECTORY that has just arrived,
	 * moved, or stopped being a file is the place rows were waiting for (rule 9).
	 */
	const place = async (row: Node, old: Node | null, path: Spot | null): Promise<Landed[]> => {
		const was = seen.get(row.id)?.path
		const landed = await put(row, old, path)
		const out = landed ? [landed] : []
		if (old && !old.deleted && (row.deleted || old.parent !== row.parent || old.name !== row.name))
			out.push(...(await promote(old.parent, old.name)))
		// Not when the row already HELD ROWS at this very path: that is every ordinary write. A
		// junction does not count — it held none, so what waited under it waited all along.
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
	 * Record what the disk holds now. Deferred to the end of a batch on purpose: adding,
	 * removing or renaming an entry bumps a DIRECTORY’s mtime, and a directory row nobody
	 * wrote must not turn up in the feed for it.
	 */
	/**
	 * Is what is at the name still what the placement left? A DIRECTORY is held only to
	 * its identity — an entry landing inside it moves its mtime, which is the whole reason
	 * this waits until now — and everything else to its whole state.
	 *
	 * Identity, because without it a directory a local tool replaced with a file would be
	 * recorded under the row that still says directory. `syncPath` would then take the
	 * unchanged path straight past it, and nothing would ever list it: the bytes that took
	 * its name would never reach the feed at all.
	 */
	const ours = (id: NodeId, landed: Landed, s: BigIntStats): boolean => {
		if (landed.was === undefined) return true
		const row = byId.get(id)
		return row !== undefined && isDir(row)
			? String(s.ino) === landed.was.ino
			: unchanged(landed.was, s)
	}

	const observe = async (placed: Landed[], dirs: Set<NodeId>): Promise<void> => {
		// A directory’s own stamp is the last word on it: an entry moves its mtime AFTER the
		// placement that stated it. One path, one owner here too — a later placement may have
		// taken the path an earlier one landed at. A directory nobody wrote keeps the mtime the
		// disk gave it.
		const held = new Map<string, NodeId>(placed.map((landed) => [landed.path, landed.id]))
		for (const landed of placed) {
			if (held.get(landed.path) !== landed.id) continue
			const row = byId.get(landed.id)
			if (!row || row.deleted || !isDir(row)) continue
			// `unseen` for the same reason this waits until now: an entry landing inside moved
			// the mtime, so what was observed before is no baseline. `ours` below decides
			// whether what answered is still the directory this pass placed.
			await disk.stamp(landed.path, stampOf(row), 'unseen')
			// Stated, and then held open if what it states shuts this store out: the
			// marking below has to look inside it, and `relock` is this pass's last act.
			if (locked(row, SEARCH)) await unlockNew(row, landed.path, SEARCH)
		}
		const where = new Map<NodeId, Landed>(placed.map((landed) => [landed.id, landed]))
		for (const id of dirs) {
			const at = seen.get(id)
			if (at && !where.has(id)) where.set(id, { id, path: at.path, hash: at.hash, was: at })
		}
		for (const [id, landed] of where) {
			const s = await disk.stat(landed.path)
			// The hash names what this pass PUT there, and the state is being read now. A
			// local tool that took the name in between makes that pair a lie: the state is
			// its file's, the hash is somebody else's bytes. Recorded, it would read as
			// already reconciled — the scan would skip the edit for ever, and `blobs` would
			// answer those bytes under a hash that does not name them. So nothing is
			// recorded, and the next scan derives what is really there.
			if (s === null || !ours(id, landed, s)) unmark(id)
			else mark(id, { path: landed.path, ino: String(s.ino), state: stateOf(s), hash: landed.hash })
		}
		// Last, because everything above had to be able to write and look through them.
		await relock()
	}

	// ── The scan: where a change nobody announced becomes a row ──────────────────

	const hashOf = async (os: Spot): Promise<Hash | null> => {
		const data = await disk.bytes(os)
		return data === null ? null : sha256Hex(data)
	}

	/** The row a file states it is. Everything POSIX knows about it, and nothing else. */
	const derive = async (path: Spot, s: BigIntStats, base: NewNode): Promise<Node | null> => {
		const kind = kindOf(s)
		// Nothing this store can say, so it says nothing: no row, and the name is left exactly
		// as it is for whoever does own it.
		if (kind === null) return null
		const row: Node = {
			id: base.id,
			parent: base.parent,
			name: base.name,
			// `mount` is the one type POSIX cannot state: on the disk a junction is just a
			// directory, so `kindOf` can only ever call it one, and a stat that re-typed it would
			// publish a change nobody made and open the junction to rows from this store. It stops
			// being one when it stops being directory-shaped at all.
			type: base.type === 'mount' && kind === 'dir' ? 'mount' : kind,
			mode: Number(s.mode),
			// The stamp the row was given, while the disk does not contradict it: a difference
			// below a millisecond is this backend’s own rounding coming back, not somebody’s
			// change. It also means a stamp set outside with finer precision than `stamp` can
			// write is a change this backend does not report — it could not have made it either.
			mtimeNs:
				base.mtimeNs !== undefined && rounded(s.mtimeNs, base.mtimeNs) ? base.mtimeNs : s.mtimeNs,
			size: s.size,
			version: mint()
		}
		// No node API carries an xattr, so the sidecar is their only home: a file
		// that changed keeps the ones its row already had.
		if (base.xattrs) row.xattrs = base.xattrs
		if (row.type === 'symlink') {
			const target = await disk.target(path)
			if (target === null) return null
			row.link = target
		}
		if (row.type === 'file') {
			const hash = await hashOf(path)
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
	const syncPath = async (dir: NodeId, name: string, path: Spot): Promise<Node | null> => {
		const s = await disk.stat(path)
		if (s === null) return null // it vanished between the listing and the look
		const has = owner.get(path)
		const row = (has === undefined ? null : byId.get(has)) ?? lookup(dir, name)
		const at = row ? seen.get(row.id) : undefined
		if (row && at && at.path === path && unchanged(at, s)) return row
		const base: NewNode = row ?? { id: crypto.randomUUID(), parent: dir, name }
		const derived = await derive(path, s, base)
		if (derived === null) return row // unreadable: leave the row alone, and try again next scan
		mark(derived.id, { path, ino: String(s.ino), state: stateOf(s), hash: derived.content })
		changed = true
		if (row && restated(row, derived)) return row
		write(derived)
		// A directory replaced out of band by a file or a symlink. Nothing lists its entries any
		// more, so what it held is buried here or nowhere.
		if (row && isDir(row) && !isDir(derived)) buryUnder(path)
		// And the other way: a name that has become a directory is a place for rows
		// that had none, whose own pages are long behind the engine's cursor.
		if (holdsRows(derived) && !(row && isDir(row))) stale.add(derived.id)
		return derived
	}

	/**
	 * Reconcile ONE directory: every entry it lists, and every live row that claims a name it
	 * no longer lists. Returns the directories underneath, for a caller that wants to walk on.
	 */
	const syncDir = async (id: NodeId, path: Spot): Promise<Landed[]> => {
		// A directory this store cannot list is left exactly as it is. It does NOT open one to
		// look: what a mode says is the owner’s to say, and widening it would weaken permissions
		// on somebody’s tree on every deep pass, for as long as a consumer polls — rsync skips
		// and reports, and so does this. A WRITE still opens its way in (`unlockFor`), because a
		// page this replica could never apply is retried for ever.
		const names = await disk.list(path)
		if (names === null) return []
		const found = new Set(names)
		const below: Landed[] = []
		for (const name of names) {
			if (path === AT_ROOT && foreign.has(name)) continue
			// A name the OS lists that this store could never address. Not adopted, and not a
			// reason to stop: the rest of the directory is still this store’s to reconcile.
			const at = under(path, name)
			if (at === null) continue
			const row = await syncPath(id, name, at)
			if (row && holdsRows(row)) below.push({ id: row.id, path: at })
		}
		// A name this directory used to hold and no longer does. Only a row whose file WAS here
		// counts: one never materialized, or parked, was never this directory’s to lose.
		const gone = new Set(namesIn(id).filter((name) => !found.has(name)))
		if (gone.size > 0) bury(path, gone)
		return below
	}

	/**
	 * Names a directory no longer lists, and everything that was under them: a directory
	 * cannot be removed while its entries are there, so a name that vanished took its whole
	 * materialized subtree with it. One pass, whatever the size of the deletion.
	 */
	const bury = (path: Spot, gone: Set<string>): void => {
		const under = path === AT_ROOT ? '' : `${path}/`
		for (const [id, at] of [...seen]) {
			if (!at.path.startsWith(under)) continue
			const [step] = at.path.slice(under.length).split('/')
			if (step === undefined || !gone.has(step)) continue
			entomb(id)
		}
	}

	/** Everything materialized UNDER a path — the row AT it left alone. */
	const buryUnder = (path: Spot): void => {
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
	 * Directories the scan changed the answer for: a name freed by a deletion made outside,
	 * or a name that became a directory. The rows waiting on that answer have no other event
	 * coming, so the pass that found it is the pass that puts them on the disk.
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
		const s = await disk.stat(AT_ROOT)
		const was = byId.get(ROOT)
		if (s === null || !was) return
		const at = seen.get(ROOT)
		if (at && unchanged(at, s)) return
		const derived = await derive(AT_ROOT, s, was)
		if (!derived) return
		mark(ROOT, { path: AT_ROOT, ino: String(s.ino), state: stateOf(s) })
		changed = true
		if (restated(was, derived)) return
		write(derived)
	}

	/**
	 * The whole tree, one directory at a time, and every file in it. What a store with no
	 * watcher does, what every store does on open and if its watcher is ever lost, and what
	 * the deep pass is: anything may have written a file, and looking is the only way to know.
	 */
	const scanAll = async (): Promise<void> => {
		changed = false
		await syncRoot()
		if (!byId.has(ROOT)) return
		const queue: Landed[] = [{ id: ROOT, path: AT_ROOT }]
		for (let dir = queue.pop(); dir !== undefined; dir = queue.pop())
			queue.push(...(await syncDir(dir.id, dir.path)))
		swept = Date.now()
		deepened = swept
		await rescue()
		await relock()
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
			const s = await disk.stat(at.path)
			if (s === null || unchanged(at, s)) continue // gone is the parent's listing to notice
			if (id !== ROOT) await syncPath(row.parent, row.name, at.path) // the directory's own row
			await syncDir(id, at.path) // and what it lists now
		}
		swept = Date.now()
		await rescue()
		await relock()
		if (changed) await save()
	}

	/**
	 * One path the OS says may have moved, and nothing else. The parent’s listing is what
	 * decides existence, so the entry is looked up there. A directory is then walked, because
	 * one event can stand for a whole subtree that arrived at once.
	 */
	const syncAt = async (path: Spot): Promise<void> => {
		if (path === AT_ROOT) return syncRoot()
		// The nearest ancestor this index knows: an event may name a path several levels below
		// anything the store has heard of, or spell a name in a normalization the rows do not
		// use, and the ancestor’s own listing is what gets it right.
		let above = up(path)
		for (let step = 0; above !== AT_ROOT && owner.get(above) === undefined; step++) {
			if (step > 64) return
			path = above
			above = up(above)
		}
		const dir = above === AT_ROOT ? ROOT : owner.get(above)
		const parent = dir === undefined ? null : byId.get(dir)
		if (dir === undefined || !parent || parent.deleted) return
		if (!holdsRows(parent)) return
		const name = above === AT_ROOT ? path : path.slice(above.length + 1)
		if (above === AT_ROOT && foreign.has(name)) return // not this store's to touch

		if (await disk.absent(path)) {
			bury(above, new Set([name]))
			return
		}
		const row = await syncPath(dir, name, path)
		if (!row || !holdsRows(row)) return
		const queue: Landed[] = [{ id: row.id, path }]
		for (let at = queue.pop(); at !== undefined; at = queue.pop())
			queue.push(...(await syncDir(at.id, at.path)))
	}

	/** Look at watch hints first, then directories, then every file on the deep pass. */
	const reconcile = async (): Promise<void> => {
		if (!armed) {
			armed = true
			// Arm before the walk, or a change during the walk is in neither place.
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
	 * The way TO a name, looked at before the name is. `lstat` does not follow the last
	 * component of a path but it follows every one before it, so a directory a local tool
	 * replaced with a symlink still answers for everything under it — and a row placed through
	 * it would land at the far end of the link, outside this store. Reconciled from the top,
	 * stopping where the tree stops.
	 */
	const settleUp = async (id: NodeId, looked: Set<NodeId>): Promise<void> => {
		const chain: Node[] = []
		for (let at = byId.get(id); at && at.id !== ROOT; at = byId.get(at.parent)) {
			if (at.deleted || looked.has(at.id)) break
			looked.add(at.id)
			chain.unshift(at)
		}
		for (const row of chain) {
			const path = pathUnder(row.parent, row.name)
			if (path === null) return
			// Gone is the other way a directory stops being one: a stale row for a directory a local
			// tool removed leaves this store believing the way down is there, so it skips the
			// `mkdir` it would otherwise do and writes to a path with nothing above it. Buried,
			// everything under it loses its path and the page lands instead of failing for ever.
			if (await disk.absent(path)) {
				bury(up(path), new Set([row.name]))
				return
			}
			await syncPath(row.parent, row.name, path)
		}
	}

	/**
	 * A few names, reconciled against the disk on their own. What a commit does before it
	 * checks a guard: whatever a local tool has done to those names becomes a row of this
	 * store’s BEFORE anything is judged or written over, so a guard answers about the tree
	 * that is there and bytes nobody published are never renamed away.
	 */
	const settle = async (touched: Iterable<[NodeId, string]>): Promise<void> => {
		changed = false
		const looked = new Set<NodeId>()
		for (const [parent, name] of touched) {
			// Root has no name to look up and no parent that lists it, so `syncRoot` is the only
			// thing that can answer for its state — including for a guard over root’s row.
			if (parent === ROOT && name === '') {
				await syncRoot()
				continue
			}
			// Every directory on the way first: what this store is about to write through
			// has to be what it thinks it is.
			await settleUp(parent, looked)
			const path = pathUnder(parent, name)
			if (path === null) continue
			// Gone is a change too, and the one a stale read-modify-write must not miss: a
			// name whose file a local tool deleted or renamed away is a tombstone, so the
			// version guard over it fails instead of quietly writing the file back.
			if (await disk.absent(path)) bury(up(path), new Set([name]))
			else await syncPath(parent, name, path)
		}
		// Closed before the save below opens a way of its own: one window at a time.
		await relock()
		if (changed) await save()
	}

	/** The paths the watcher named. O(what changed), which is the point of having one. */
	const drain = async (): Promise<void> => {
		// A directory before what is inside it, so a subtree that arrived at once is
		// adopted from the top; and the parent of every path, because adding or
		// removing an entry is a change to the DIRECTORY's own row as well.
		const paths = new Set<Spot>()
		for (const path of dirty) {
			paths.add(path)
			paths.add(up(path))
		}
		dirty.clear()
		changed = false
		for (const path of [...paths].sort()) await syncAt(path)
		await rescue()
		await relock()
		if (changed) await save()
	}

	// ── The watcher: the OS says where to look ───────────────────────────────────

	/** Paths the OS says may have changed. Reconciled before subscribers hear about them. */
	const dirty = new Set<Spot>()
	let watcher: (() => void) | null = null
	/** Has the first feed read or subscription asked for a watcher? */
	let armed = false
	/** Is one listening? False means the walk is the only thing that reports. */
	let watching = false
	/** When the last cheap look and the last deep one finished. */
	let swept = 0
	let deepened = 0

	/**
	 * Arm the OS. An event is a HINT and nothing more: macOS calls an in-place write a rename
	 * and names ancestors beside the leaf, and any platform may coalesce or drop under load.
	 * So the type is ignored, the name only says where to look, and losing the watcher costs
	 * a walk rather than correctness.
	 */
	const arm = (): void => {
		watcher = disk.watch((spot) => {
			dirty.add(spot)
			scheduleReconcile(0)
		}, lost)
		watching = watcher !== null
	}

	/**
	 * The watcher is gone or said something it could not name. From here on the walk carries
	 * it alone — on the cheap floor, since nothing else reports an in-place write.
	 */
	const lost = (): void => {
		watcher?.()
		watcher = null
		watching = false
		dirty.clear()
		swept = 0
	}

	// ── Content: the files themselves ────────────────────────────────────────────

	/** Where bytes wait while no row names them yet. Null for a key that is no hash. */
	const spill = (hash: Hash): Spot | null => (HASH.test(hash) ? under(spilled, hash) : null)

	/**
	 * The file that holds these bytes: a row that names the hash, while the disk
	 * still holds what this store last observed there.
	 */
	const fileFor = async (hash: Hash): Promise<Seen | null> => {
		for (const id of holders.get(hash) ?? []) {
			const at = seen.get(id)
			if (!at) continue
			const s = await disk.stat(at.path)
			if (s !== null && unchanged(at, s)) return at
		}
		return null
	}

	/**
	 * The bytes a hash names: the spill, or else the file of a row that names it. A file
	 * is not a blob store — a local tool can rewrite it between the look that chose it
	 * and the read that returns it, and those bytes would go out under a key that no
	 * longer names them: into another row's file as its content, or to a peer. So the
	 * read is bracketed by the state, and bytes that moved under it are no answer.
	 *
	 * The state and not the digest, because a key here need not BE the digest of its
	 * bytes — `verifiedBlobs` is where that is required, and only of a `put`. `ctimeNs`
	 * is what makes the bracket hold: it moves on any change to the inode, and userland
	 * cannot set it back.
	 */
	const readBlob = async (hash: Hash): Promise<Uint8Array | null> => {
		const waiting = spill(hash)
		const held = waiting === null ? null : await disk.bytes(waiting)
		if (held !== null) return held
		const at = await fileFor(hash)
		if (at === null) return null
		const data = await disk.bytes(at.path)
		if (data === null) return null
		const s = await disk.stat(at.path)
		return s !== null && unchanged(at, s) ? data : null
	}

	/**
	 * Bytes for a hash a row already names but whose file does not hold them yet — a stub
	 * materialized before its content arrived. The file IS the data here, so a `put` is the
	 * only chance it gets: without this a store read would answer while `cat` kept showing an
	 * empty file. A walk of the rows, because a stub is rare and an index would be a fourth
	 * thing to keep in step.
	 */
	const hydrate = async (hash: Hash, data: Uint8Array): Promise<boolean> => {
		const placed: Landed[] = []
		const dirs = new Set<NodeId>()
		for (const row of [...byId.values()]) {
			if (row.deleted || row.content !== hash) continue
			const at = seen.get(row.id)
			if (!at || at.hash === hash) continue
			// Only over the file this store last saw. A local tool can write into the placeholder
			// while the content is still on its way, and that edit is the only copy of itself
			// there is — so the write carries the observation and lands only while it holds. A
			// name that moved under it is looked at again instead, which makes what the file
			// holds a row, and a row naming other content is no stub waiting for these bytes.
			await unlockFor(up(at.path))
			const now = await disk.write(at.path, data, stampOf(row), at)
			if (now === null) {
				await settle([[row.parent, row.name]])
				continue
			}
			placed.push({ id: row.id, path: at.path, hash, was: now })
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
		// What the directory is before this store touches it. Its own mode decides whether the
		// sidecar inside it can be written or read at all, so a root that shuts this store out is
		// opened for the open — and the row seeded below states what was there.
		const s = await disk.stat(AT_ROOT)
		if (s === null) throw new Error(`fsStore: cannot read ${root}`)
		const shut = (Number(s.mode) & (WRITE | SEARCH)) !== (WRITE | SEARCH)
		// `unseen` both ways: this is the open, so nothing has been observed yet, and by the
		// time it is put back this store's own chmod has moved what `s` describes.
		if (shut)
			await disk.stamp(AT_ROOT, { mode: (Number(s.mode) & 0o7777) | WRITE | SEARCH }, 'unseen')
		// Creates the tree itself when it is not there — and BEFORE root's state is
		// taken down, so the sidecar's own arrival is not a change to it.
		await disk.dir(spilled)
		const loaded = await load()
		if (!loaded) {
			lineage = crypto.randomUUID() // rule 11: a fresh sidecar is a fresh lineage
			const seed = await derive(AT_ROOT, s, { id: ROOT, parent: ROOT, name: '' })
			// Rule 6: the root row, and the one row whose id is not minted here.
			if (seed === null) throw new Error(`fsStore: cannot read ${root}`)
			write(seed)
			mark(ROOT, { path: AT_ROOT, ino: String(s.ino), state: stateOf(s) })
		}
		// And closed again before anything looks — to what was FOUND, not to what the sidecar
		// remembered: a local tool may have set a mode while this store was not running, and
		// putting the remembered one back would revert somebody's chmod and then record the
		// revert as the truth. What was found is left for the scan below, which publishes it.
		if (shut) await disk.stamp(AT_ROOT, { mode: Number(s.mode) & 0o7777 }, 'unseen')
		// The watcher is not armed here. The first feed read or subscription does that, so a
		// consumer that only reads and writes never asks the OS for one. The index is rebuilt
		// against the tree on open, so a path resolves when the store is there. This is the one
		// pass that takes no turn of its own, so it closes its own way in.
		try {
			await scanAll()
		} finally {
			await relock()
		}
		// A lineage nobody else can read fences every cursor this instance hands out, so a fresh
		// sidecar is saved even when the tree it describes is empty and the scan found nothing.
		if (!loaded && !changed) await save()
	}

	let opening: Promise<void> | null = null
	// Not serialized: everything below awaits this before it takes its turn, so
	// nothing can interleave with the open itself.
	const open = (): Promise<void> => (opening ??= start())

	const copy = (n: Node): Node => structuredClone(n)
	const listeners = new Set<(writes: Node[]) => void>()
	let scanTimer: ReturnType<typeof setTimeout> | undefined
	let scanning = false
	let stopped = false
	let retryFrom: number | undefined

	const publishSince = (from: number): void => {
		if (stopped || listeners.size === 0) return
		const rows: Node[] = []
		for (const [id, at] of order) {
			if (at < from) continue
			const row = byId.get(id)
			if (row) rows.push(row)
		}
		if (rows.length === 0) return
		for (const listener of listeners)
			try {
				listener(rows.map(copy))
			} catch {
				// The listener owns its errors.
			}
	}

	/** Save and publish rows found by a disk check. A failed turn keeps its first position. */
	const publishChanges = async (work: () => Promise<void>): Promise<void> => {
		const from = retryFrom ?? next
		try {
			await work()
			// A failed save leaves the new rows in memory. Save them on the next turn,
			// even when the scan finds no further disk change.
			if (retryFrom !== undefined) await save()
		} catch (error) {
			retryFrom ??= from
			throw error
		}
		publishSince(from)
		retryFrom = undefined
	}

	const reconcileAndPublish = (): Promise<void> => publishChanges(reconcile)

	/** One queued scan at a time. Watch hints replace the slower fallback timer. */
	const scheduleReconcile = (delay: number): void => {
		if (stopped || listeners.size === 0 || scanning) return
		if (scanTimer !== undefined) {
			if (delay > 0) return
			clearTimeout(scanTimer)
		}
		scanTimer = setTimeout(() => {
			scanTimer = undefined
			if (stopped || listeners.size === 0 || scanning) return
			scanning = true
			void open()
				.then(() =>
					serial(async () => {
						if (!stopped) await reconcileAndPublish()
					})
				)
				.catch(() => {})
				.finally(() => {
					scanning = false
					scheduleReconcile(dirty.size > 0 ? 0 : SWEEP_MS)
				})
		}, delay)
	}

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
			// One row per name, in one stable name order, and only the names of THIS directory: the
			// cursor is the last name emitted, so a resumed listing neither skips nor repeats.
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
			await serial(reconcileAndPublish)
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
		 * Rule 2: every guard is checked before anything is touched, so a REJECTED commit
		 * writes nothing. A commit that FAILS is the weaker model this backend documents —
		 * POSIX has no transaction to roll back.
		 */
		async commit(writes, guards) {
			// Taken before the first await, which is where the caller gets control
			// back and may edit a row it just handed over (rule 3).
			const batch = structuredClone(writes)
			const checks = structuredClone(guards)
			await open()
			return serial(async () => {
				// What this batch is about to touch, looked at on the DISK first: the names it takes,
				// and the names its guards ask about. A guard answered from an index that has not
				// looked since the last poll is answered about a tree that may no longer exist — a
				// `free` name a local tool has taken passes, and the placement then renames over bytes
				// nobody published. Only these paths, because a commit is not a scan.
				const touched = new Map<string, [NodeId, string]>()
				const touch = (parent: NodeId, name: string): void =>
					void touched.set(parent + SEP + name, [parent, name])
				for (const row of batch) {
					// Where it is going, and where it is now: a move renames the file as it IS,
					// so a look at the destination alone would carry bytes this store has not
					// seen under a hash that does not name them.
					if (!row.deleted) touch(row.parent, row.name)
					const held = byId.get(row.id)
					if (held && !held.deleted) touch(held.parent, held.name)
				}
				for (const guard of checks ?? []) {
					if ('free' in guard) touch(guard.free.parent, guard.free.name)
					else {
						const held = byId.get(guard.version.id)
						if (held && !held.deleted) touch(held.parent, held.name)
					}
				}
				await publishChanges(() => settle(touched.values()))

				for (const guard of checks ?? []) if (!passes(guard)) throw new GuardError(guard)
				const from = next

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

				// Then ONE order for the disk, because the disk has one: a directory has to be at its
				// new name before a child goes into it, and empty before it goes itself. Depth does
				// both, and the contract does not order a commit inside itself.
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
				// The bytes live in their file now, so the copy that carried them there goes. Before
				// `observe`, which is the end of the window in which the way through a restrictive
				// directory — including root, which the spill is inside — is still open.
				for (const landed of placed) {
					const waiting = landed.hash === undefined ? null : spill(landed.hash)
					if (waiting !== null) await disk.clear(waiting)
				}
				await observe(placed, dirs)
				await save()
				publishSince(from)
			})
		},

		subscribe(listener) {
			listeners.add(listener)
			scheduleReconcile(0)
			return () => {
				listeners.delete(listener)
				if (listeners.size === 0 && scanTimer !== undefined) {
					clearTimeout(scanTimer)
					scanTimer = undefined
				}
			}
		},

		/**
		 * Stop new watch and scan work, then wait for the current open and store turn. The store
		 * still answers by walking the tree, but a caller that closed it must treat it as done.
		 */
		async close() {
			stopped = true
			listeners.clear()
			if (scanTimer !== undefined) clearTimeout(scanTimer)
			scanTimer = undefined
			lost()
			await opening?.catch(() => {})
			await tail
		},

		blobs: {
			async has(hash) {
				await open()
				const waiting = spill(hash)
				if (waiting !== null && (await disk.stat(waiting)) !== null) return true
				return (await fileFor(hash)) !== null
			},

			async get(hash) {
				await open()
				return readBlob(hash)
			},

			/**
			 * Rule 7: content-keyed and immutable, so bytes already here are already the answer
			 * and a second put is nothing. What lands is a snapshot taken before the first await.
			 */
			async put(hash, data) {
				const bytes = new Uint8Array(data)
				await open()
				const waiting = spill(hash)
				// A key that is not a digest names no file here, and nothing could ever
				// hash to it: the bytes contradict the name they were offered under.
				if (waiting === null) throw new HashMismatchError(hash)
				return serial(async () => {
					// A row that was waiting for these bytes takes them into its own file,
					// which is where content lives here. Then the spill has nothing to keep.
					const filled = await hydrate(hash, bytes)
					if (filled) return save()
					// `unseen`: the spill is this store's own corner, no row names it, and the
					// line above is what establishes there is nothing there to hold this to.
					if ((await disk.stat(waiting)) === null && (await fileFor(hash)) === null)
						await disk.write(waiting, bytes, undefined, 'unseen')
				})
			}
		}
	}
}

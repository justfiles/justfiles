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
 * Mounts are the one thing here that is not a view over ONE store. A binding
 * joins another store in at a name, and resolution crosses into it the way a
 * kernel crosses a vfsmount — so `store` is never assumed below: every read and
 * every commit goes to the store the path resolved into. Nothing else in the
 * system learns of any of it, which is the whole point — a sync engine is handed
 * one store, and what is behind a mount was never in it.
 *
 * T18 renames this to `volume`.
 */

import {
	type Cursor,
	ForeignCursorError,
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
import { type Volume, WATCH_BURST_MS, type WatchEvent } from './volume'

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
	const author = crypto.randomUUID()
	let n = 0
	return () => `local:${author}:${++n}`
}

/**
 * The author tag inside a `Version`: everything before its last `:`. Storage
 * treats a version as opaque, and this is the one thing anything above it reads
 * out of one — the same tag the engine filters its push on (design, push-filter
 * bullet), so the format is a standing contract between minters, not a detail
 * of `watch`.
 *
 * A version with no `:` names no author, so it reads as somebody else's: a
 * consumer that answers only remote changes then answers one time too many,
 * which is recoverable, rather than never, which is not.
 */
const authorOf = (version: Version): string => {
	const cut = version.lastIndexOf(':')
	return cut === -1 ? version : version.slice(0, cut)
}

/** The only `source` this model can report: some other replica wrote the row. */
const REMOTE = 'remote'

/**
 * fstab, as data: which store stands at which name, inside which directory.
 *
 * The mount POINT is shared — an ordinary `mount` row, claiming its name through
 * the ordinary `free` guard — and the BINDING is local, so a replica joins its
 * own store in behind a name every replica can see. A binding with no row under
 * it is a SILENT mount: nothing is written anywhere, so no peer can learn even
 * that the name exists.
 *
 * Keyed by the mount point rather than by the mount row's id, because a silent
 * binding has no row to key on — and because it is fstab: a position in the
 * tree. Move the point and the binding stays where it was pointed, exactly as an
 * fstab entry does.
 */
export type Bindings = Map<NodeId, Map<string, Store>>

export function storeVolume(
	store: Store,
	opts?: { bindings?: Bindings; mintVersion?: () => Version }
): Volume {
	const mint = opts?.mintVersion ?? localVersions()
	const bindings = opts?.bindings
	const now = (): bigint => BigInt(Date.now()) * 1_000_000n

	/**
	 * What is bound inside one directory, if anything.
	 *
	 * Only in the store this volume was built over: bindings are positions in ITS
	 * tree, and what a bound store holds is its own business — a mount is where
	 * this table stops. A binding at the root would otherwise reappear inside
	 * every store it binds.
	 */
	const boundIn = (st: Store, dir: NodeId): Map<string, Store> | undefined =>
		st === store ? bindings?.get(dir) : undefined

	/**
	 * A resolved path: the row it names, and the store that holds it.
	 *
	 * The two travel together because an id only means something in the store that
	 * minted it — every store spells its root `ROOT`, so ids collide across a
	 * mount. Nothing below compares an id, guards on one, or walks up from one
	 * without the store it came from beside it.
	 */
	type At = { store: Store; node: Node }

	/** Where a walk stands. `node` is `null` at the root of `store`. */
	type Step = { store: Store; node: Node | null }

	/** One row a feed delivered, with the store it came from. */
	type Seen = { from: Store; row: Node }

	/** The same row in the same store — never the id alone, which two stores share. */
	const is = (a: At | null, row: Node, from: Store): boolean =>
		a !== null && a.store === from && a.node.id === row.id

	/** The same again, between two resolutions: has this path landed somewhere new? */
	const sameAt = (a: At | null, b: At | null): boolean =>
		a === null || b === null ? a === b : is(a, b.node, b.store)

	/**
	 * Walk from the root, one `child` per segment. `followLast` decides whether a
	 * final symlink is followed (`stat` vs `lstat`).
	 *
	 * `at` is where the walk stands and a `null` node is the root of the store it
	 * stands in — the one row whose id is a constant, so a path that never lands on
	 * it costs no `get` on the hottest read in the system. `up` holds the ancestors,
	 * so `..` is a pop, and popping past the top leaves the root, which is what
	 * `/..` means. `walked`, when given, keeps each row read so a later commit can
	 * guard the path — each with the store it was read in, since a walk that
	 * crosses a mount reads rows no one commit can guard together.
	 */
	async function resolve(path: string, followLast: boolean, walked?: At[]): Promise<At> {
		const queue = path.split('/').filter((s) => s !== '')
		const up: Step[] = []
		let at: Step = { store, node: null }
		let hops = 0

		for (let i = 0; i < queue.length; i++) {
			const name = queue[i]
			if (name === undefined || name === '.') continue
			if (name === '..') {
				at = up.pop() ?? { store, node: null }
				continue
			}

			// The mount crossing, and the whole of it. A binding is read BEFORE the
			// row lookup, so a bound name never reaches the table underneath: an
			// announced mount's own row is never even read — a kernel reports the
			// MOUNTED root's inode for a mountpoint, not the directory beneath it —
			// and a silent binding shadows whatever rows a peer pushed down there.
			const into = boundIn(at.store, at.node?.id ?? ROOT)?.get(name)
			if (into !== undefined) {
				if (at.node && !isDir(at.node)) throw new Error(`ENOTDIR: ${path}`)
				up.push(at)
				at = { store: into, node: null }
				continue
			}

			const found = await at.store.child(at.node?.id ?? ROOT, name)
			if (found === null) throw new Error(`ENOENT: ${path}`)
			walked?.push({ store: at.store, node: found })
			// Rule 9 again: "every parent a live directory" is the authority's to
			// keep, so a replica may hold a row parented on a file. Reachability
			// from the root is what makes a row visible, and POSIX cannot walk
			// through a file — so this one is not reachable. The test comes after
			// the lookup, not before it, to leave a name no row holds as ENOENT.
			if (at.node && !isDir(at.node)) throw new Error(`ENOTDIR: ${path}`)

			const isLast = i === queue.length - 1
			if (found.type === 'symlink' && (!isLast || followLast)) {
				if (++hops > MAX_SYMLINK_HOPS) throw new Error('ELOOP: too many levels of symbolic links')
				if (!found.link) throw new Error('EINVAL: symlink has no target')
				if (found.link.startsWith('/')) {
					up.length = 0
					// An absolute target starts at the GLOBAL root, whichever store the
					// link itself lives in. That is what makes one synced symlink into a
					// local mount resolve to different bytes on every replica.
					at = { store, node: null }
				}
				// Splice the target in where the link was, so the rest of the path
				// carries on behind it and a target of its own gets the same treatment.
				queue.splice(i, 1, ...found.link.split('/').filter((s) => s !== ''))
				i--
				continue
			}

			up.push(at)
			at = { store: at.store, node: found }
		}

		if (at.node) return { store: at.store, node: at.node }
		const root = await at.store.get(ROOT)
		if (!root) throw new Error(`ENOENT: ${path}`) // rule 6: unreachable on a live store
		walked?.push({ store: at.store, node: root })
		return { store: at.store, node: root }
	}

	/** Resolve, or `null` where the path simply is not there. */
	async function find(path: string, followLast = true): Promise<At | null> {
		try {
			return await resolve(path, followLast)
		} catch (e) {
			if (e instanceof Error && e.message.startsWith('ENOENT')) return null
			throw e
		}
	}

	/** The directory a path is created in, the store that holds it, and the name it takes there. */
	async function parentOf(
		path: string,
		walked?: At[]
	): Promise<{ store: Store; dir: Node; name: string }> {
		const full = path.replace(/\/+$/, '')
		const cut = full.lastIndexOf('/')
		const name = full.slice(cut + 1)
		if (name === '' || name === '.' || name === '..') throw new Error(`EINVAL: ${path}`)
		const at = await resolve(cut <= 0 ? '/' : full.slice(0, cut), true, walked)
		if (!isDir(at.node)) throw new Error(`ENOTDIR: ${path}`)
		// An UNBOUND mount is an empty read-only directory, and the emptiness is the
		// data's doing rather than a rule kept here: only a directory may be a parent,
		// so no row of this store can ever sit below it, on any replica. Bind it, or
		// nothing goes in. A bound one is never seen here — resolution crossed it.
		if (at.node.type === 'mount') throw new Error(`EROFS: ${path}`)
		return { store: at.store, dir: at.node, name }
	}

	/** One directory listing, page after page — the seam hands back a cursor until it is done. */
	async function* childrenOf(st: Store, parent: NodeId): AsyncGenerator<Node> {
		let cursor: Cursor | undefined
		do {
			const page = await st.children(parent, cursor)
			yield* page.nodes
			cursor = page.next
		} while (cursor !== undefined)
	}

	/**
	 * One directory's entries, with its mounts crossed: the row a name holds, or
	 * the root of the store bound over it. A binding shadows the row of the same
	 * name — a kernel mount over a non-empty directory — so each name appears once,
	 * and a listing can never contradict what resolving that name gives.
	 */
	async function* entriesOf(st: Store, dir: NodeId): AsyncGenerator<At & { name: string }> {
		const bound = boundIn(st, dir)
		for await (const child of childrenOf(st, dir))
			if (!bound?.has(child.name)) yield { name: child.name, store: st, node: child }
		for (const [name, into] of bound ?? []) {
			// A store with no root is not one rule 6 allows, and one bad binding is no
			// reason to fail the whole listing: leave the name out.
			const root = await into.get(ROOT)
			if (root !== null) yield { name, store: into, node: root }
		}
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
	 * Every caller guards what it stamps. This is a whole-row write, so a stamp
	 * built from a stale read would put a removed or moved directory back exactly
	 * as it was. The cost is that two writers in one directory replan instead of
	 * running side by side — which is what a real filesystem does too, by taking
	 * that directory's lock.
	 */
	const stamp = (dir: Node): Node => ({ ...dir, mtimeNs: now(), version: mint() })

	/** A tombstone is still a whole row; only `deleted` and the version speak. */
	const tomb = (node: Node): Node => ({ ...node, deleted: true, version: mint() })

	/**
	 * What a WRITE states about a row: its kind and its bytes. Not its mtime, which
	 * a write always moves to now, and not its xattrs, which belong to the name.
	 * A MOVE states none of it — see `moveAcross`, which carries whole rows.
	 */
	type Payload = {
		type: Node['type']
		mode: number
		size: bigint
		content?: Hash
		link?: string
	}

	/** The bytes a payload names: the caller's array, or the store that has them. */
	type Bytes = Uint8Array | Store

	/**
	 * Rule 10, with a mount in the way: the bytes are durable IN THE STORE THE ROW
	 * LANDS IN before that row names them. A crash between the two leaves an orphan
	 * blob; the other order leaves a committed row whose content was never stored,
	 * which is lost data — and a hash is nothing but a promise to a store that does
	 * not hold the bytes, so crossing a mount is where that promise gets kept.
	 */
	async function durable(st: Store, content?: Hash, bytes?: Bytes): Promise<void> {
		if (content === undefined || bytes === undefined) return
		if (bytes instanceof Uint8Array) return st.blobs.put(content, bytes)
		// Ask before hauling: a transfer usually has nothing to transfer.
		if (bytes === st || (await st.blobs.has(content))) return
		const data = await bytes.blobs.get(content)
		if (data === null) throw new Error(`ENOENT: content ${content}`)
		await st.blobs.put(content, data)
	}

	/** Whole-row replace (rule 3: no partial patch), guarded on what we read. */
	const swap = async (st: Store, node: Node, payload: Payload, bytes?: Bytes): Promise<void> => {
		await durable(st, payload.content, bytes)
		await st.commit(
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
	}

	/** Claim a free name for a new row, and stamp the directory that gained it. */
	async function create(
		path: string,
		payload: Payload,
		exclusive?: boolean,
		bytes?: Bytes
	): Promise<void> {
		const { store: st, dir, name } = await parentOf(path)
		const row: Node = {
			id: crypto.randomUUID(), // minted once, never rebound
			parent: dir.id,
			name,
			mtimeNs: now(),
			version: mint(),
			...payload
		}
		await durable(st, payload.content, bytes)
		try {
			await st.commit([row, stamp(dir)], [{ free: { parent: dir.id, name } }, unchanged(dir)])
		} catch (e) {
			if (!(e instanceof GuardError)) throw e
			// WHICH guard failed decides what this is. A name still free means the
			// PARENT moved under this attempt, so the caller replans — the stamp
			// writes the whole directory row back, and a row read before a concurrent
			// `rm -r` would bring that directory back to life after the removal
			// reported success.
			const holder = await st.child(dir.id, name)
			if (holder === null) throw e
			// An id-local holder does not prove that the path still reaches this
			// parent. It may have moved before another writer took the name.
			if ((await find(path, false)) === null) throw e
			// A write through a dangling link can never resolve, so the name is
			// taken. A symlink payload replaces the link itself and replans instead.
			if (exclusive || (payload.type !== 'symlink' && (await find(path)) === null))
				throw new Error(`EEXIST: ${path}`)
			throw e
		}
	}

	/**
	 * Create the row a path names, or replace the one already there — one commit
	 * either way. A symlink payload replaces the final link; other payloads follow
	 * it. `exclusive` refuses a taken name; `update` refuses a free one.
	 */
	async function place(
		path: string,
		payload: Payload,
		opts?: { exclusive?: boolean; update?: boolean },
		bytes?: Bytes
	): Promise<void> {
		const there = await find(path, payload.type !== 'symlink')
		if (there !== null) {
			if (opts?.exclusive) throw new Error(`EEXIST: ${path}`)
			if (isDir(there.node)) throw new Error(`EISDIR: ${path}`)
			return swap(there.store, there.node, payload, bytes)
		}
		if (opts?.update) throw new Error(`ENOENT: ${path}`)
		await create(path, payload, opts?.exclusive, bytes)
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
			const at = await resolve(path, true)
			await at.store.commit([{ ...change(at.node), version: mint() }], [unchanged(at.node)])
		})

	/** Walk from `node` to root. Return whether it reaches `ancestor` and each row read. */
	async function within(
		st: Store,
		node: Node,
		ancestor: NodeId
	): Promise<{ inside: boolean; rows: Node[] }> {
		const seen = new Set<NodeId>()
		const rows: Node[] = []
		let at: Node | null = node
		while (at !== null && !seen.has(at.id)) {
			rows.push(at)
			if (at.id === ancestor) return { inside: true, rows }
			if (at.id === ROOT) return { inside: false, rows }
			seen.add(at.id)
			at = await st.get(at.parent)
		}
		return { inside: false, rows }
	}

	/**
	 * Every row under a directory, in ONE store. A mount is not crossed: what it
	 * holds is another store's rows, and this is the list of rows a delete is about
	 * to tombstone here.
	 */
	async function descendants(st: Store, id: NodeId): Promise<Node[]> {
		const out: Node[] = []
		const seen = new Set<NodeId>([id])
		const queue: NodeId[] = [id]
		for (let dir = queue.pop(); dir !== undefined; dir = queue.pop())
			for await (const child of childrenOf(st, dir)) {
				if (seen.has(child.id)) continue
				seen.add(child.id)
				out.push(child)
				if (isDir(child)) queue.push(child.id)
			}
		return out
	}

	/**
	 * Copy a subtree. Rows, not bytes: a copy names the content its source already
	 * stored (design table A — "no byte copy; hash reuse"), which is also why a
	 * symlink copies as a symlink instead of dereferencing into a fresh file. A
	 * copy that crosses a mount is the one exception, and only for the bytes:
	 * `place` carries them, because a hash names nothing in a store that lacks it.
	 *
	 * It carries what a copy carries and no more: POSIX `cp` needs `-a` before it
	 * preserves xattrs or times either. A MOVE owes more than this, which is why
	 * `moveAcross` does not go through it.
	 */
	async function copy(src: string, dest: string, recursive: boolean): Promise<void> {
		const at = await resolve(src, false)
		const payload: Payload = {
			type: at.node.type,
			mode: at.node.mode,
			size: at.node.size,
			content: at.node.content,
			link: at.node.link
		}
		if (!isDir(at.node)) {
			await retry(() => place(dest, payload, undefined, at.store))
			return
		}

		if (!recursive) throw new Error(`EISDIR: ${src}`)
		// Paths lie about ancestry when they cross a link. Walk ids so a copy
		// cannot find its own output and run without bound — and only within one
		// store, since a destination in another cannot be inside this one.
		const there = await find(dest)
		// Where the copy lands: the destination itself, or — with nothing there
		// yet — the directory it would be created in.
		let anchor: At | null = there
		if (anchor === null) {
			const up = await parentOf(dest)
			anchor = { store: up.store, node: up.dir }
		}
		if (anchor.store === at.store && (await within(at.store, anchor.node, at.node.id)).inside)
			throw new Error(`EINVAL: cannot copy ${src} into itself`)

		const names: string[] = []
		for await (const entry of entriesOf(at.store, at.node.id)) names.push(entry.name)

		if (there === null) await retry(() => place(dest, payload, { exclusive: true }))
		else if (!isDir(there.node)) throw new Error(`ENOTDIR: ${dest}`)
		for (const name of names) await copy(join(src, name), join(dest, name), recursive)
	}

	/**
	 * `mv` across a store, which is what `EXDEV` leaves behind. It moves ROWS, and
	 * that is the whole of why it is not `copy` then `rm`.
	 *
	 * A copy is a different operation, and every difference is a way for a rename
	 * built out of one to quietly mean something else. It chooses what to carry
	 * (POSIX `cp` needs `-a` before it takes xattrs or times); it writes THROUGH a
	 * symlink standing on the destination, overwriting a file nobody named; and it
	 * MERGES into a directory instead of taking its place. A move states its rule
	 * once instead, and the rule is the whole row:
	 *
	 *     { ...row, id: <fresh>, parent, name, version }
	 *
	 * Nothing is enumerated, so nothing can be left out — mode, xattrs, times, and
	 * whatever a later field on `Node` adds, all travel by construction. The id is
	 * the one thing that cannot travel: it belongs to the store that minted it.
	 *
	 * Not atomic, and it cannot be: two stores are two commits. That IS `EXDEV`.
	 *
	 * So it only attempts a move it can make WHOLE, and says `EXDEV` to the rest —
	 * which is what the kernel says to EVERY cross-device rename, emulation being
	 * userspace's job there. Half a move is worse than none, and each refusal below
	 * is a move this cannot finish. A caller that wants one copies and removes, with
	 * the semantics it chooses.
	 */
	async function moveAcross(oldPath: string, newPath: string): Promise<void> {
		// Not followed: `mv` moves the link itself.
		const src = await resolve(oldPath, false)
		// A store's own root is not a row to move. `/private` is the mount POINT, an
		// ordinary row in the store that holds it, and moving THAT is a one-store
		// rename the primitive already made — this is resolution having crossed into
		// what the point leads to.
		if (src.node.id === ROOT) throw new Error(`EXDEV: ${oldPath} is a mount point`)
		// A destination that exists would have to be replaced, and two stores are two
		// commits: there is no moment where the name holds one or the other, and a
		// failure between them takes the target with it.
		if ((await find(newPath, false)) !== null) throw new Error(`EXDEV: ${newPath} is taken`)
		// A mount under the source is a route into a third store, and the row that
		// holds it is one this move is about to tombstone. Re-creating it elsewhere
		// would leave two points and one binding, and removing it strands the store.
		if (await holdsMount(src, new Set([src.node.id])))
			throw new Error(`EXDEV: ${oldPath} holds a mount`)
		// The moved row and the directory that gains it commit together — the
		// parent-mtime rule, exactly as a create does — and replan together.
		const top = await retry(async () => {
			const to = await parentOf(newPath)
			const row = reparent(src.node, to.dir.id, to.name)
			await durable(to.store, row.content, src.store)
			await to.store.commit(
				[row, stamp(to.dir)],
				[{ free: { parent: to.dir.id, name: to.name } }, unchanged(to.dir)]
			)
			return { store: to.store, node: row }
		})
		// Below the top row nothing is contended: every name is claimed inside a
		// directory this move has just made.
		if (isDir(src.node)) await graft(src, top, new Set([src.node.id]))
		await vol.rm(oldPath, { recursive: true })
	}

	/** One row, placed somewhere else. The whole rule of a move. */
	const reparent = (row: Node, parent: NodeId, name: string): Node => ({
		...row,
		id: crypto.randomUUID(),
		parent,
		name,
		version: mint()
	})

	/**
	 * Everything under `from`, written into `into`. A mount is not crossed: its row
	 * moves like any other and its binding stays where it was pointed, which is
	 * what the one-store rename does too. Crossing would write another store's rows
	 * into this one, which is the whole thing a mount exists to prevent.
	 *
	 * Bounded by a visited set, like every other walk here (rule 9).
	 */
	async function graft(from: At, into: At, seen: Set<NodeId>): Promise<void> {
		for await (const child of childrenOf(from.store, from.node.id)) {
			if (seen.has(child.id)) continue
			seen.add(child.id)
			const row = reparent(child, into.node.id, child.name)
			await durable(into.store, row.content, from.store)
			await into.store.commit([row], [{ free: { parent: row.parent, name: row.name } }])
			if (isDir(child))
				await graft({ store: from.store, node: child }, { store: into.store, node: row }, seen)
		}
	}

	/**
	 * Is there a mount at or under this row? Bounded by a visited set (rule 9).
	 *
	 * Both kinds count. An announced one is a `mount` row; a silent one is a binding
	 * with no row at all, so the table is what has to be asked.
	 */
	async function holdsMount(at: At, seen: Set<NodeId>): Promise<boolean> {
		if (boundIn(at.store, at.node.id) !== undefined) return true
		for await (const child of childrenOf(at.store, at.node.id)) {
			if (seen.has(child.id)) continue
			seen.add(child.id)
			if (child.type === 'mount') return true
			if (isDir(child) && (await holdsMount({ store: at.store, node: child }, seen))) return true
		}
		return false
	}

	/**
	 * A rename, as ONE guarded commit — and one commit belongs to one store, so a
	 * path that resolves into another is `EXDEV`, exactly as it is on a real
	 * filesystem. `vol.rename` is the `mv` that answers it.
	 */
	const moveRow = (oldPath: string, newPath: string): Promise<void> =>
		retry(async () => {
			const walked: At[] = []
			const from = await parentOf(oldPath, walked)
			// Not followed, again: `mv` moves the link itself.
			const node = await from.store.child(from.dir.id, from.name)
			if (node === null) throw new Error(`ENOENT: ${oldPath}`)
			const to = await parentOf(newPath, walked)
			if (to.store !== from.store) throw new Error(`EXDEV: ${oldPath} -> ${newPath}`)
			// Moving a row below itself makes a detached cycle.
			const checked = await within(from.store, to.dir, node.id)
			if (checked.inside) throw new Error(`EINVAL: ${newPath} is inside ${oldPath}`)
			const target = await from.store.child(to.dir.id, to.name)
			if (target?.id === node.id) return // the same row, in the same place

			// ONE row moves, whatever hangs below it: a child's location is
			// `(parent, name)`, and neither field changed. This is the O(1) move.
			const writes: Node[] = [{ ...node, parent: to.dir.id, name: to.name, version: mint() }]
			const guards: Guard[] = [
				unchanged(node),
				// Keep repeat ids: two versions mean the path changed between walks. Both
				// walks are here, and both are needed — a path that reaches into a mount
				// crosses on EVERY walk, so keeping only the last one would drop what the
				// first read and let a moved ancestor through. What is dropped instead is
				// what this commit could never guard: rows another store minted.
				...walked.filter((step) => step.store === from.store).map((step) => unchanged(step.node)),
				// `to.dir` is guarded below. The other guards keep this check valid.
				...checked.rows
					.slice(1)
					.filter((row) => row.id !== ROOT)
					.map(unchanged)
			]
			if (target === null) guards.push({ free: { parent: to.dir.id, name: to.name } })
			else {
				// POSIX rename replaces, but only like for like. A directory is never
				// replaced by a file, a file never by a directory, and a directory that
				// still holds entries is never replaced at all: its children would be
				// left parented on a tombstone, which loses them.
				if (isDir(target) !== isDir(node))
					throw new Error(`${isDir(target) ? 'EISDIR' : 'ENOTDIR'}: ${newPath}`)
				// Safe to read and then act on: the guard below fails if anything is
				// created inside the target after this listing (the stamp rule).
				if (isDir(target) && (await from.store.children(target.id)).nodes.length > 0)
					throw new Error(`ENOTEMPTY: ${newPath}`)
				// The displaced row is tombstoned in the SAME commit, so no reader
				// ever sees the name twice or not at all.
				writes.push(tomb(target))
				guards.push(unchanged(target))
			}
			// Both directories changed shape — one stamp when they are one directory.
			writes.push(stamp(from.dir))
			guards.push(unchanged(from.dir))
			if (to.dir.id !== from.dir.id) {
				writes.push(stamp(to.dir))
				guards.push(unchanged(to.dir))
			}
			await from.store.commit(writes, guards)
		})

	/**
	 * Was this row written somewhere else? The old model answered by threading a
	 * `MutationOptions.origin` through every write, which the sync engine tagged
	 * `'remote'`; this model deletes origin tags outright, and the row answers
	 * for itself, because its `Version` carries its author.
	 *
	 * That is what keeps `WatchEvent.source` worth having: a consumer watches a
	 * file it also writes, and must react only to the writes it did not make —
	 * frieren re-reads an app's state on a remote change and would loop on its
	 * own. Nothing in the types can recover this; it is why `source` outlived
	 * the origins it used to carry.
	 *
	 * `me` is sampled from the mint rather than configured, because the caller
	 * may mint versions itself (the engine will). One burned version is cheaper
	 * than a second option that has to agree with the first: versions are opaque
	 * and only ever compared for equality, so a gap in the counter costs nothing.
	 */
	let me: string | undefined
	const foreign = (row: Node): boolean => {
		me ??= authorOf(mint())
		return authorOf(row.version) !== me
	}

	/**
	 * Take a watch's position on the change feed, then let it `bind` to the tree
	 * it is watching, holding back whatever commits in between.
	 *
	 * The order is the whole point. A watch has to be ON the feed before it reads
	 * the tree, or a commit that lands between the read and the subscription is
	 * neither in what it read nor in what it will be told — and for a subtree that
	 * is not one missed event but a watch that can never wake at all: the create
	 * it missed is the one that would have bound its root, and every later write
	 * inside that root stamps a directory the watch has never heard of. Held rows
	 * are then replayed against the bound state, so a commit the bind DID see is
	 * assessed twice — one wake too many, which a re-scan absorbs, rather than
	 * none, which nothing does.
	 *
	 * `restarted` is called when the feed had to start over because the store was
	 * reset or replaced (rule 11). Only a watch whose bindings are ids from the
	 * lineage that is gone needs telling: `watchTree` finds out by itself, because
	 * ROOT is on its way in and every row is in the feed, so the replay probes it.
	 *
	 * Every feed this volume can reach is taken, and each batch is handed over with
	 * the store it came from — because a mount means the path may live on any of
	 * them, and WHICH one is a question only a read of the tree can answer. Asking
	 * it first would put that read in front of the subscription, which is the one
	 * order that loses an event. So the watch subscribes to all of them and lets
	 * `bind` say afterwards which one it is listening to.
	 */
	async function changes(
		bind: () => Promise<void>,
		listener: (from: Store, rows: Node[]) => void,
		restarted?: () => void
	): Promise<() => void> {
		let holding = true
		let held: [Store, Node[]][] = []
		const take = (from: Store, rows: Node[]): void => {
			if (holding) held.push([from, rows])
			else listener(from, rows)
		}
		const feeds = new Set<Store>([store])
		for (const bound of bindings?.values() ?? []) for (const into of bound.values()) feeds.add(into)
		const offs = await Promise.all(
			[...feeds].map((feed) =>
				feed.subscribe
					? feed.subscribe((rows) => take(feed, rows))
					: poll(feed, (rows) => take(feed, rows), restarted)
			)
		)
		await bind()
		holding = false
		const missed = held
		held = []
		for (const [from, rows] of missed) listener(from, rows)
		return () => {
			for (const off of offs) off()
		}
	}

	/**
	 * The feed a store without `subscribe` still has: `since`, read on a timer.
	 * Nothing above can tell the two apart beyond latency — which is what lets
	 * the seam leave `subscribe` optional at all.
	 */
	async function poll(
		feed: Store,
		listener: (rows: Node[]) => void,
		restarted?: () => void
	): Promise<() => void> {
		// Start at the tip: a watch reports what happens after it, never the
		// history the feed was already holding.
		let cursor = await drain(feed)
		let reading = false
		const tick = setInterval(() => {
			if (reading) return // a slow read is not a reason to start another
			reading = true
			const rows: Node[] = []
			drain(feed, cursor, rows)
				.then((at) => {
					cursor = at
					if (rows.length > 0) listener(rows)
				})
				.catch((e: unknown) => {
					// Rule 11: the store was reset or replaced under this watch, so the
					// cursor names a position in a lineage that is gone and no later
					// read from it can ever succeed. The contract's answer is to start
					// again from the empty cursor — which for a watch is also the right
					// event, since everything the new store holds is news to it.
					if (e instanceof ForeignCursorError) {
						cursor = undefined
						restarted?.()
					}
					// Any other failure is retried by the next tick, from the same cursor.
				})
				.finally(() => {
					reading = false
				})
		}, WATCH_BURST_MS)
		return () => clearInterval(tick)
	}

	/** Read the feed to its end from `cursor`, collecting the rows if asked. */
	async function drain(feed: Store, cursor?: Cursor, into?: Node[]): Promise<Cursor | undefined> {
		for (;;) {
			const page = await feed.since(cursor)
			into?.push(...page.nodes)
			// The contract has `since` always hand a cursor back; a store that does
			// not gives no next position, so this read is the last one.
			if (page.next === undefined) return cursor
			cursor = page.next
			if (page.nodes.length === 0) return cursor
		}
	}

	/**
	 * One path, watched the way inotify watches one: the resolved row (its own
	 * edits) AND the `(directory, name)` that binds the path (a rebind). Either
	 * may be missing — a watch on a path that does not exist yet binds as soon
	 * as something takes the name.
	 *
	 * Delivery coalesces onto a microtask, not the window `watchTree` uses: this
	 * watches ONE row, so a burst is already bounded by how often that row is
	 * written, and an event here carries a change rather than asking for a re-scan.
	 */
	async function watchPath(
		path: string,
		listener: (event: WatchEvent) => void
	): Promise<() => void> {
		// What a watch remembers, it remembers WITH its store. Every feed is listened
		// to (see `changes`) and every row arrives with the store it came from, so
		// nothing here has to decide up front which store the path lives in — a
		// question only a read of the tree answers, and a watch is armed before it may
		// read one. A path whose parent does not exist yet has no answer at all.
		let node: At | null = null
		let dir: (At & { name: string }) | null = null
		async function bind(): Promise<void> {
			// Every way of not being there — missing, unwalkable, looping — is the
			// same answer to a watch: unbound.
			node = await resolve(path, true).catch(() => null)
			const parent = await parentOf(path).catch(() => null)
			dir = parent === null ? null : { store: parent.store, node: parent.dir, name: parent.name }
		}

		let scheduled = false
		let rebind = false
		let fire = false
		let remote = false
		let stopped = false

		/** Coalesce the commits of one turn into one event. */
		const schedule = (): void => {
			if (scheduled) return
			scheduled = true
			queueMicrotask(async () => {
				scheduled = false
				const definite = fire
				const before = node
				const source = remote ? REMOTE : undefined
				fire = false
				remote = false
				if (rebind) {
					rebind = false
					await bind()
				}
				// A re-resolve that landed somewhere new IS the event, whether the path
				// gained a row, lost one, or was rebound to another. A speculative one
				// that changed nothing is not.
				if (!stopped && (definite || !sameAt(node, before))) listener({ source })
			})
		}

		const off = await changes(
			bind,
			(from, rows) => {
				for (const row of rows) {
					const hitsNode = is(node, row, from)
					// A tombstone counts, and must: when the watched path IS a symlink,
					// `node` is what it resolved THROUGH to, so unlinking the link itself
					// hits nothing else — and a watch that missed it would go on reporting
					// edits to a target the path no longer names.
					const hitsName =
						dir !== null &&
						from === dir.store &&
						row.parent === dir.node.id &&
						row.name === dir.name
					// With no parent directory yet there is no name to compare against, so
					// any directory row in any store is a candidate: re-resolve, and fire
					// only if it turned out to bind the path.
					const mayBind = dir === null && isDir(row)
					if (!hitsNode && !hitsName && !mayBind) continue
					if (hitsNode || hitsName) fire = true
					// The row left the path (deleted, or moved elsewhere), or something
					// else moved onto it: either way the path resolves somewhere new.
					const moved = row.deleted === true || !hitsName
					if (hitsName || mayBind || (hitsNode && moved)) rebind = true
					if (foreign(row)) remote = true
				}
				if (fire || rebind) schedule()
			},
			() => {
				// The store was replaced under this watch, so `node` and `dir` are ids
				// from a lineage that no longer answers: nothing in the new store can
				// match them, and no replayed row would ever wake this watch again.
				// Re-resolve, and report if the path landed somewhere else — which it
				// did if the replacement does not hold it. Whoever swapped the store
				// out, it was not this replica writing a row, so it reads as remote.
				rebind = true
				remote = true
				schedule()
			}
		)

		return () => {
			stopped = true // a scheduled delivery must not outlive the watch
			off()
		}
	}

	/**
	 * A subtree, watched as a WAKE: "the listing you are showing is stale". Two
	 * things can make it stale, and this is the whole of it.
	 *
	 * - A directory row at or under the root was committed. Every create, delete
	 *   and rename stamps the directory it happened in, in the SAME commit (the
	 *   parent-mtime rule above), so a committed directory row IS a listing that
	 *   changed — while a content edit writes one file row and no directory,
	 *   which is exactly why editing a file does not wake a tree watcher. A
	 *   tombstone counts too: it always removes an entry from somewhere.
	 * - A row the resolution walked through was committed. That is the way in,
	 *   and a rename of an ancestor empties the subtree without touching one row
	 *   inside it — a child's location is `(parent, name)`, and neither field
	 *   changed. Those rows are re-resolved instead of read, and the wake is the
	 *   root having moved. A root that does not exist yet holds the rows its
	 *   walk did reach, which is precisely what the create that binds it stamps.
	 *
	 * Re-resolving the way in also means a re-pointed symlink re-targets the
	 * watch, where `inotify_add_watch` would have pinned it at add time. Nothing
	 * here can hold a resolution still: every read on this volume follows the
	 * link, so a watch that did not would report on a subtree its owner has
	 * stopped reading.
	 */
	async function watchTree(
		path: string,
		listener: (event: WatchEvent) => void
	): Promise<() => void> {
		// Rows come from every feed, each with its store, exactly as in `watchPath`.
		let root: At | null = null
		let chain: At[] = []
		async function bind(): Promise<void> {
			const walked: At[] = []
			root = await resolve(path, true, walked).catch(() => null)
			chain = walked
		}

		/**
		 * Is this row on the way in? A store's root always is — it is where every walk
		 * starts, and it is what the create that first binds an unbound path stamps.
		 */
		const onChain = (from: Store, row: Node): boolean =>
			row.id === ROOT || chain.some((step) => is(step, row, from))

		/**
		 * Is `id` the root or under it? Bounded by a visited set (rule 9), and it
		 * climbs within ONE store: a mount is where the walk stops, so a recursive
		 * watch above one is not told what happens inside it.
		 */
		async function under(from: Store, id: NodeId, memo: Map<NodeId, boolean>): Promise<boolean> {
			const climbed: NodeId[] = []
			const seen = new Set<NodeId>()
			let at: NodeId | undefined = id
			let answer = false
			while (at !== undefined && !seen.has(at)) {
				const known = memo.get(at)
				if (known !== undefined) {
					answer = known
					break
				}
				if (root !== null && from === root.store && at === root.node.id) {
					answer = true
					break
				}
				if (at === ROOT) break
				seen.add(at)
				climbed.push(at)
				at = (await from.get(at))?.parent
			}
			// Whatever the answer, it holds for every id on the way up: they all
			// reach the root through the same rows.
			for (const step of climbed) memo.set(step, answer)
			return answer
		}

		async function assess(batch: Seen[]): Promise<{ wake: boolean; source?: string }> {
			// One memo per store: an id answers for a climb in the store that minted it.
			const memos = new Map<Store, Map<NodeId, boolean>>()
			const memo = (from: Store): Map<NodeId, boolean> => {
				const held = memos.get(from) ?? new Map<NodeId, boolean>()
				memos.set(from, held)
				return held
			}
			let wake = false
			let probe = false
			// Attribution is a question about the WINDOW, not about the rows that wake
			// us — because the rows that would answer it precisely are the ones the
			// feed destroys. A window holds several commits, and a polled feed carries
			// each row once at its LATEST state: a remote create's parent stamp is
			// overwritten by the next local write to that directory, and a remote
			// rename OUT of the subtree leaves its moved row pointing somewhere else
			// entirely. Every way of scoping the question re-opens one of those holes,
			// so it is not scoped. This over-reports when unrelated remote traffic
			// shares a window with a local change — a re-scan absorbs that, while a
			// missed remote change is the thing `source` exists to prevent.
			const remote = batch.some(({ row }) => foreign(row))
			for (const { from, row } of batch) {
				const structural = isDir(row) || row.deleted === true
				if (structural && (is(root, row, from) || (await under(from, row.parent, memo(from)))))
					wake = true
				if (onChain(from, row)) probe = true
			}
			if (probe) {
				const was = root
				await bind()
				if (!sameAt(root, was)) wake = true
			}
			return { wake, source: remote ? REMOTE : undefined }
		}

		let queued: Seen[] = []
		let timer: ReturnType<typeof setTimeout> | undefined
		let stopped = false
		// At most one delivery per window, always with a trailing one. Arming only
		// while something is queued keeps an idle watch timer-free; re-arming after
		// a delivery is what bounds the RATE — the next change waits out a fresh
		// window instead of firing at once.
		const arm = (): void => {
			if (timer !== undefined || stopped) return
			timer = setTimeout(async () => {
				timer = undefined
				if (queued.length === 0) return
				const batch = queued
				queued = []
				// A read that failed may have hidden a change: wake rather than miss it.
				const { wake, source } = await assess(batch).catch(() => ({
					wake: true,
					source: undefined
				}))
				if (!wake || stopped) return
				arm()
				listener({ source })
			}, WATCH_BURST_MS)
		}

		const off = await changes(bind, (from, rows) => {
			for (const row of rows) queued.push({ from, row })
			arm()
		})

		return () => {
			stopped = true
			queued = []
			if (timer !== undefined) clearTimeout(timer)
			timer = undefined
			off()
		}
	}

	// Read caller-owned inputs before the first await. Reuse them on every retry.
	const vol: Volume = {
		async stat(path) {
			return statOf((await resolve(path, true)).node)
		},

		async lstat(path) {
			return statOf((await resolve(path, false)).node)
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
			return (await resolve(path, true)).node.xattrs?.[name] ?? null
		},

		async setXattr(path, name, value) {
			const held = new Uint8Array(value)
			await edit(path, (row) => ({ ...row, xattrs: { ...row.xattrs, [name]: held } }))
		},

		async listXattr(path) {
			return Object.keys((await resolve(path, true)).node.xattrs ?? {})
		},

		async removeXattr(path, name) {
			await edit(path, (row) => {
				const xattrs = { ...row.xattrs }
				delete xattrs[name]
				return { ...row, xattrs }
			})
		},

		async readFile(path) {
			const at = await resolve(path, true)
			if (isDir(at.node)) throw new Error(`EISDIR: ${path}`)
			if (at.node.content === undefined) return new Uint8Array()
			const data = await at.store.blobs.get(at.node.content)
			// A row may name content this replica does not hold — a lazy stub, not
			// an empty file. T9 fetches it; saying so is the only honest answer.
			if (data === null) throw new Error(`ENOENT: content ${at.node.content} of ${path}`)
			return data
		},

		async writeFile(path, data, opts) {
			const options = opts && { ...opts }
			// One snapshot, hashed once: the caller still owns `data` and may edit it
			// while the write is in flight. `place` is what puts the bytes down, once
			// it knows which store the row is landing in.
			const held = new Uint8Array(data)
			const payload = file(held.length, await sha256Hex(held))
			await retry(() => place(path, payload, options, held))
		},

		async appendFile(path, data) {
			const held = new Uint8Array(data)
			await retry(async () => {
				const at = await find(path)
				if (at !== null && isDir(at.node)) throw new Error(`EISDIR: ${path}`)
				// Read-modify-write at the view layer: the model has no range write
				// (design #2, deliberate omissions). The guard below is what keeps the
				// read and the write one operation — a second append that lost the race
				// reads again rather than dropping the first one's entry.
				const before =
					at?.node.content === undefined
						? new Uint8Array()
						: await at.store.blobs.get(at.node.content)
				if (before === null) throw new Error(`ENOENT: content ${at?.node.content} of ${path}`)
				const merged = new Uint8Array(before.length + held.length)
				merged.set(before)
				merged.set(held, before.length)
				const payload = file(merged.length, await sha256Hex(merged))
				// Appending to nothing is a create, and the name and the bytes still
				// commit as one fact.
				await (at === null
					? create(path, payload, undefined, merged)
					: swap(at.store, at.node, payload, merged))
			})
		},

		async mkdir(path, opts) {
			const recursive = opts?.recursive ?? false
			const mode = IFDIR | ((opts?.mode ?? 0o755) & 0o7777)
			const dir: Payload = { type: 'dir', mode, size: 0n }
			if (!recursive) {
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
					if (!isDir(there.node))
						throw new Error(i === parts.length - 1 ? `EEXIST: ${path}` : `ENOTDIR: ${walked}`)
					continue
				}
				try {
					await retry(() => place(walked, dir, { exclusive: true }))
				} catch (e) {
					// Another walk got there first. `-p` is idempotent, so a directory
					// standing where this one was going is success, not EEXIST.
					const raced = await find(walked)
					if (raced === null || !isDir(raced.node)) throw e
				}
			}
		},

		async readdir(path) {
			const at = await resolve(path, true)
			if (!isDir(at.node)) throw new Error(`ENOTDIR: ${path}`)
			const entries: Dirent[] = []
			// A crossed entry reports the bound store's root id — unique in that store
			// the way a POSIX inode number is unique within a device, and this model
			// has no `st_dev` to tell two of them apart.
			for await (const entry of entriesOf(at.store, at.node.id))
				entries.push({ ino: entry.node.id, name: entry.name, type: TYPE[entry.node.type] })
			return entries
		},

		async rm(path, opts) {
			const recursive = opts?.recursive ?? false
			const force = opts?.force ?? false
			await retry(async () => {
				// The final component is not followed: `rm` removes the link, never
				// what it points at.
				const at = await find(path, false)
				if (at === null) {
					if (force) return
					throw new Error(`ENOENT: ${path}`)
				}
				// A BOUND mount point resolves to the bound store's root, and that is
				// the one row nothing removes — `EBUSY` by another name, and the right
				// answer: unbind it first, the way a filesystem is unmounted before its
				// mountpoint goes. An unbound one is an ordinary row and goes with it.
				if (at.node.id === ROOT) throw new Error(`EINVAL: ${path}`)
				const dir = await at.store.get(at.node.parent)
				if (dir === null || dir.deleted) throw new Error(`ENOENT: ${path}`)
				if (!isDir(dir)) throw new Error(`ENOTDIR: ${path}`)

				const dead = [at.node]
				if (isDir(at.node)) {
					if (recursive) dead.push(...(await descendants(at.store, at.node.id)))
					else if ((await at.store.children(at.node.id)).nodes.length > 0)
						throw new Error(`ENOTEMPTY: ${path}`)
				}
				// One batch, one guard per row it replaces — the parent it stamps
				// included. A directory's version moves on every create inside it, so an
				// entry this walk never saw fails the commit, and the attempt enumerates
				// again.
				await at.store.commit(
					[...dead.map(tomb), stamp(dir)],
					[...dead.map(unchanged), unchanged(dir)]
				)
			})
		},

		async rename(oldPath, newPath) {
			try {
				await moveRow(oldPath, newPath)
			} catch (e) {
				if (!(e instanceof Error) || !e.message.startsWith('EXDEV')) throw e
				await moveAcross(oldPath, newPath)
			}
		},

		cp(src, dest, opts) {
			return copy(src, dest, opts?.recursive ?? false)
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
			const { node } = await resolve(path, false)
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
			const at = await resolve(path, true)
			await visitor(path, statOf(at.node))
			if (!isDir(at.node)) return

			// Rule 9: a replica may transiently hold detached or cyclic rows, so the
			// walk bounds itself instead of trusting what it is walking to be a tree.
			async function walk(
				st: Store,
				dir: NodeId,
				dirPath: string,
				seen: Set<NodeId>
			): Promise<void> {
				for await (const entry of entriesOf(st, dir)) {
					// A crossing is the bound store's ROOT, and a scan of `/` already holds
					// that id: it would find the mount visited and skip it whole. So a
					// crossing is neither checked against this walk's set nor added to it,
					// and starts one of its own — a cycle is per store too.
					const crossed = entry.store !== st
					if (!crossed) {
						if (seen.has(entry.node.id)) continue
						seen.add(entry.node.id)
					}
					const childPath = join(dirPath, entry.name)
					await visitor(childPath, statOf(entry.node))
					if (isDir(entry.node))
						await walk(
							entry.store,
							entry.node.id,
							childPath,
							crossed ? new Set([entry.node.id]) : seen
						)
				}
			}
			await walk(at.store, at.node.id, path, new Set([at.node.id]))
		},

		async watch(path, listener, opts) {
			return opts?.recursive ? watchTree(path, listener) : watchPath(path, listener)
		}
	}

	return vol
}

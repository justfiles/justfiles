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
	 * `walked`, when given, keeps each row read so a later commit can guard the path.
	 */
	async function resolve(path: string, followLast: boolean, walked?: Node[]): Promise<Node> {
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
			walked?.push(found)
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
		walked?.push(root)
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
	async function parentOf(path: string, walked?: Node[]): Promise<{ dir: Node; name: string }> {
		const full = path.replace(/\/+$/, '')
		const cut = full.lastIndexOf('/')
		const name = full.slice(cut + 1)
		if (name === '' || name === '.' || name === '..') throw new Error(`EINVAL: ${path}`)
		const dir = await resolve(cut <= 0 ? '/' : full.slice(0, cut), true, walked)
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
	 * Every caller guards what it stamps. This is a whole-row write, so a stamp
	 * built from a stale read would put a removed or moved directory back exactly
	 * as it was. The cost is that two writers in one directory replan instead of
	 * running side by side — which is what a real filesystem does too, by taking
	 * that directory's lock.
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
	async function create(path: string, payload: Payload, exclusive?: boolean): Promise<void> {
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
			await store.commit([row, stamp(dir)], [{ free: { parent: dir.id, name } }, unchanged(dir)])
		} catch (e) {
			if (!(e instanceof GuardError)) throw e
			// WHICH guard failed decides what this is. A name still free means the
			// PARENT moved under this attempt, so the caller replans — the stamp
			// writes the whole directory row back, and a row read before a concurrent
			// `rm -r` would bring that directory back to life after the removal
			// reported success.
			const holder = await store.child(dir.id, name)
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
		opts?: { exclusive?: boolean; update?: boolean }
	): Promise<void> {
		const there = await find(path, payload.type !== 'symlink')
		if (there !== null) {
			if (opts?.exclusive) throw new Error(`EEXIST: ${path}`)
			if (isDir(there)) throw new Error(`EISDIR: ${path}`)
			return swap(there, payload)
		}
		if (opts?.update) throw new Error(`ENOENT: ${path}`)
		await create(path, payload, opts?.exclusive)
	}

	/**
	 * Rule 10: the bytes are durable before any row names them. A crash between
	 * the two leaves an orphan blob — the other order leaves a committed row whose
	 * content was never stored, which is lost data.
	 */
	const durable = async (data: Uint8Array): Promise<Hash> => {
		// The caller can change its array while the digest runs. Hash and store one copy.
		const held = new Uint8Array(data)
		const content = await sha256Hex(held)
		await store.blobs.put(content, held)
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

	/** Walk from `node` to root. Return whether it reaches `ancestor` and each row read. */
	async function within(node: Node, ancestor: NodeId): Promise<{ inside: boolean; rows: Node[] }> {
		const seen = new Set<NodeId>()
		const rows: Node[] = []
		let at: Node | null = node
		while (at !== null && !seen.has(at.id)) {
			rows.push(at)
			if (at.id === ancestor) return { inside: true, rows }
			if (at.id === ROOT) return { inside: false, rows }
			seen.add(at.id)
			at = await store.get(at.parent)
		}
		return { inside: false, rows }
	}

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
	 */
	async function changes(
		bind: () => Promise<void>,
		listener: (rows: Node[]) => void,
		restarted?: () => void
	): Promise<() => void> {
		let holding = true
		let held: Node[] = []
		const take = (rows: Node[]): void => {
			if (holding) held.push(...rows)
			else listener(rows)
		}
		const off = store.subscribe ? store.subscribe(take) : await poll(take, restarted)
		await bind()
		holding = false
		const missed = held
		held = []
		if (missed.length > 0) listener(missed)
		return off
	}

	/**
	 * The feed a store without `subscribe` still has: `since`, read on a timer.
	 * Nothing above can tell the two apart beyond latency — which is what lets
	 * the seam leave `subscribe` optional at all.
	 */
	async function poll(
		listener: (rows: Node[]) => void,
		restarted?: () => void
	): Promise<() => void> {
		// Start at the tip: a watch reports what happens after it, never the
		// history the feed was already holding.
		let cursor = await drain()
		let reading = false
		const tick = setInterval(() => {
			if (reading) return // a slow read is not a reason to start another
			reading = true
			const rows: Node[] = []
			drain(cursor, rows)
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
	async function drain(cursor?: Cursor, into?: Node[]): Promise<Cursor | undefined> {
		for (;;) {
			const page = await store.since(cursor)
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
		let node: NodeId | null = null
		let dir: NodeId | null = null
		let name = ''
		async function bind(): Promise<void> {
			// Every way of not being there — missing, unwalkable, looping — is the
			// same answer to a watch: unbound.
			node = (await resolve(path, true).catch(() => null))?.id ?? null
			const parent = await parentOf(path).catch(() => null)
			dir = parent?.dir.id ?? null
			name = parent?.name ?? ''
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
				if (!stopped && (definite || node !== before)) listener({ source })
			})
		}

		const off = await changes(
			bind,
			(rows) => {
				for (const row of rows) {
					const hitsNode = row.id === node
					// A tombstone counts, and must: when the watched path IS a symlink,
					// `node` is what it resolved THROUGH to, so unlinking the link itself
					// hits nothing else — and a watch that missed it would go on reporting
					// edits to a target the path no longer names.
					const hitsName = dir !== null && row.parent === dir && row.name === name
					// With no parent directory yet there is no name to compare against, so
					// any directory row is a candidate: re-resolve, and fire only if it
					// turned out to bind the path.
					const mayBind = dir === null && isDir(row)
					if (!hitsNode && !hitsName && !mayBind) continue
					if (hitsNode || hitsName) fire = true
					// The row left the path (deleted, or moved elsewhere), or something
					// else moved onto it: either way the path resolves somewhere new.
					const moved = row.deleted === true || row.parent !== dir || row.name !== name
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
		let root: NodeId | null = null
		let chain = new Set<NodeId>([ROOT])
		async function bind(): Promise<void> {
			const walked: Node[] = []
			root = (await resolve(path, true, walked).catch(() => null))?.id ?? null
			chain = new Set([ROOT, ...walked.map((row) => row.id)])
		}

		/** Is `id` the root or under it? Bounded by a visited set (rule 9). */
		async function under(id: NodeId, memo: Map<NodeId, boolean>): Promise<boolean> {
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
				if (at === root) {
					answer = true
					break
				}
				if (at === ROOT) break
				seen.add(at)
				climbed.push(at)
				at = (await store.get(at))?.parent
			}
			// Whatever the answer, it holds for every id on the way up: they all
			// reach the root through the same rows.
			for (const step of climbed) memo.set(step, answer)
			return answer
		}

		async function assess(rows: Node[]): Promise<{ wake: boolean; source?: string }> {
			const memo = new Map<NodeId, boolean>()
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
			const remote = rows.some(foreign)
			for (const row of rows) {
				const structural = isDir(row) || row.deleted === true
				if (structural && root !== null && (row.id === root || (await under(row.parent, memo))))
					wake = true
				if (chain.has(row.id)) probe = true
			}
			if (probe) {
				const was = root
				await bind()
				if (root !== was) wake = true
			}
			return { wake, source: remote ? REMOTE : undefined }
		}

		let queued: Node[] = []
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
				const rows = queued
				queued = []
				// A read that failed may have hidden a change: wake rather than miss it.
				const { wake, source } = await assess(rows).catch(() => ({
					wake: true,
					source: undefined
				}))
				if (!wake || stopped) return
				arm()
				listener({ source })
			}, WATCH_BURST_MS)
		}

		const off = await changes(bind, (rows) => {
			queued.push(...rows)
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
			const held = new Uint8Array(value)
			await edit(path, (row) => ({ ...row, xattrs: { ...row.xattrs, [name]: held } }))
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
			const options = opts && { ...opts }
			const size = data.length
			const content = await durable(data)
			await retry(() => place(path, file(size, content), options))
		},

		async appendFile(path, data) {
			const held = new Uint8Array(data)
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
				const merged = new Uint8Array(before.length + held.length)
				merged.set(before)
				merged.set(held, before.length)
				const payload = file(merged.length, await durable(merged))
				// Appending to nothing is a create, and the name and the bytes still
				// commit as one fact.
				await (node === null ? create(path, payload) : swap(node, payload))
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
			const recursive = opts?.recursive ?? false
			const force = opts?.force ?? false
			await retry(async () => {
				// The final component is not followed: `rm` removes the link, never
				// what it points at.
				const node = await find(path, false)
				if (node === null) {
					if (force) return
					throw new Error(`ENOENT: ${path}`)
				}
				if (node.id === ROOT) throw new Error(`EINVAL: ${path}`)
				const dir = await store.get(node.parent)
				if (dir === null || dir.deleted) throw new Error(`ENOENT: ${path}`)
				if (!isDir(dir)) throw new Error(`ENOTDIR: ${path}`)

				const dead = [node]
				if (isDir(node)) {
					if (recursive) dead.push(...(await descendants(node.id)))
					else if ((await store.children(node.id)).nodes.length > 0)
						throw new Error(`ENOTEMPTY: ${path}`)
				}
				// One batch, one guard per row it replaces — the parent it stamps
				// included. A directory's version moves on every create inside it, so an
				// entry this walk never saw fails the commit, and the attempt enumerates
				// again.
				await store.commit(
					[...dead.map(tomb), stamp(dir)],
					[...dead.map(unchanged), unchanged(dir)]
				)
			})
		},

		async rename(oldPath, newPath) {
			await retry(async () => {
				const walked: Node[] = []
				const from = await parentOf(oldPath, walked)
				// Not followed, again: `mv` moves the link itself.
				const node = await store.child(from.dir.id, from.name)
				if (node === null) throw new Error(`ENOENT: ${oldPath}`)
				const to = await parentOf(newPath, walked)
				// Moving a row below itself makes a detached cycle.
				const checked = await within(to.dir, node.id)
				if (checked.inside) throw new Error(`EINVAL: ${newPath} is inside ${oldPath}`)
				const target = await store.child(to.dir.id, to.name)
				if (target?.id === node.id) return // the same row, in the same place

				// ONE row moves, whatever hangs below it: a child's location is
				// `(parent, name)`, and neither field changed. This is the O(1) move.
				const writes: Node[] = [{ ...node, parent: to.dir.id, name: to.name, version: mint() }]
				const guards: Guard[] = [
					unchanged(node),
					// Keep repeat ids: two versions mean the path changed between walks.
					...walked.map(unchanged),
					// `to.dir` is guarded below. The other guards keep this check valid.
					...checked.rows
						.slice(1)
						.filter((row) => row.id !== ROOT)
						.map(unchanged)
				]
				if (target === null) guards.push({ free: { parent: to.dir.id, name: to.name } })
				else {
					// POSIX rename replaces, but only like for like. A directory is never
					// replaced by a file, a file never by a directory, and a directory
					// that still holds entries is never replaced at all: its children
					// would be left parented on a tombstone, which loses them.
					if (isDir(target) !== isDir(node))
						throw new Error(`${isDir(target) ? 'EISDIR' : 'ENOTDIR'}: ${newPath}`)
					// Safe to read and then act on: the guard below fails if anything is
					// created inside the target after this listing (the stamp rule).
					if (isDir(target) && (await store.children(target.id)).nodes.length > 0)
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
				await store.commit(writes, guards)
			})
		},

		async cp(src, dest, opts) {
			const recursive = opts?.recursive ?? false
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

			if (!recursive) throw new Error(`EISDIR: ${src}`)
			// Paths lie about ancestry when they cross a link. Walk ids so a copy
			// cannot find its own output and run without bound.
			const there = await find(dest)
			if ((await within(there ?? (await parentOf(dest)).dir, node.id)).inside)
				throw new Error(`EINVAL: cannot copy ${src} into itself`)

			const kids: Node[] = []
			for await (const child of childrenOf(node.id)) kids.push(child)

			if (there === null) await vol.mkdir(dest, { mode: node.mode & 0o7777 })
			else if (!isDir(there)) throw new Error(`ENOTDIR: ${dest}`)
			for (const child of kids)
				await vol.cp(join(src, child.name), join(dest, child.name), { recursive })
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

		async watch(path, listener, opts) {
			return opts?.recursive ? watchTree(path, listener) : watchPath(path, listener)
		}
	}

	return vol
}

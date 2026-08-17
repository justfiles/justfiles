/**
 * A `Disk` that is not a disk. The same tree, the same inodes, the same
 * permission rules, in memory — so `fsStore` can be run thousands of times a
 * second, deterministically, with faults injected wherever a test wants one.
 *
 * It exists for the oracle. A property test that has to make real files can do a
 * few hundred cases before it is too slow to run in CI, and every one of them is
 * at the mercy of the host's timestamp granularity and the OS's own scheduling;
 * this does tens of thousands and does them the same way every time. `memStore`
 * already gives the answers to compare against, so what was missing was a disk
 * that could be driven — and driven off a seed.
 *
 * The rules it keeps, because they are the ones the findings were about:
 *
 * - **Permissions.** SEARCH to walk through a directory, READ to list one, WRITE
 *   and SEARCH to add or remove an entry in one. A denial is `EACCES`, not
 *   "nothing there" — the distinction a scan has to make and used to lose.
 * - **Identity.** Every object has an inode, minted once, and a rename carries it.
 *   Two files with the same name at different times are not the same file.
 * - **Time.** A counter, not a clock, so runs are identical. `ctime` moves on
 *   every change to an object and cannot be set; `stamp` writes an mtime rounded
 *   to the millisecond, which is what a `Date` carries and therefore all the real
 *   backend can write either.
 *
 * Where it differs, it differs on the strict side. A symlink in the MIDDLE of a
 * path is not followed here — a real `lstat` follows every component but the last
 * — so a path through one fails instead of resolving. There is no outside for it
 * to resolve to, which is the honest reason: the escape that matters about a
 * symlinked ancestor can only be shown against a real filesystem, and it is
 * (`store.fs.test.ts`).
 */

import type { BigIntStats } from 'node:fs'
import {
	AT_ROOT,
	type Disk,
	READ,
	SEARCH,
	type Seen,
	type Spot,
	spot,
	stateOf,
	under,
	up,
	WRITE
} from './disk'
import type { NodeId } from './store'

type Kind = 'file' | 'dir' | 'symlink'

type Obj = {
	ino: bigint
	kind: Kind
	/** Permission bits only. The type bits are added by `stat`. */
	perm: number
	mtimeNs: bigint
	ctimeNs: bigint
	data?: Uint8Array
	link?: string
	kids?: Map<string, Obj>
}

const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

/** The error the real thing throws, so a caller cannot tell them apart. */
const oops = (code: string, at: string): NodeJS.ErrnoException =>
	Object.assign(new Error(`${code}: ${at}`), { code })

/**
 * What a test wants to go wrong. Called before every operation that touches the
 * tree, with the operation's name and where it is aimed; returning a code makes
 * the call fail with it, exactly as the platform would.
 */
export type Fault = (op: string, at: Spot) => string | null

export function memDisk(fault: Fault = () => null): Disk {
	let inos = 1n
	// A counter rather than a clock: the same seed has to produce the same states,
	// and a real clock makes a test that passes on a fast machine and fails on a
	// slow one.
	let tick = 1_000_000_000n
	const now = (): bigint => (tick += 1_000_000n)

	const root: Obj = {
		ino: inos++,
		kind: 'dir',
		perm: 0o755,
		mtimeNs: now(),
		ctimeNs: now(),
		kids: new Map()
	}

	/** Every path a watcher would have named, for the tests that want one. */
	let listener: ((at: Spot) => void) | null = null
	const stirred = (at: Spot): void => listener?.(at)

	const check = (op: string, at: Spot): void => {
		const code = fault(op, at)
		if (code !== null) throw oops(code, at)
	}

	/**
	 * The object a spot names, and the directory holding it. Every step needs
	 * SEARCH on the directory it passes through — which is what makes a `0000`
	 * directory hide what is under it rather than merely refuse to be listed.
	 */
	const walk = (at: Spot): { obj: Obj | null; dir: Obj | null; name: string } => {
		if (at === AT_ROOT) return { obj: root, dir: null, name: '' }
		const names = at.split('/')
		let dir = root
		for (const step of names.slice(0, -1)) {
			if (dir.kind !== 'dir') throw oops('ENOTDIR', at)
			if ((dir.perm & SEARCH) !== SEARCH) throw oops('EACCES', at)
			const next = dir.kids?.get(step)
			if (next === undefined) throw oops('ENOENT', at)
			dir = next
		}
		if (dir.kind !== 'dir') throw oops('ENOTDIR', at)
		if ((dir.perm & SEARCH) !== SEARCH) throw oops('EACCES', at)
		const name = names[names.length - 1] ?? ''
		return { obj: dir.kids?.get(name) ?? null, dir, name }
	}

	/** The same walk, for a caller that needs the object to be there. */
	const must = (at: Spot): Obj => {
		const { obj } = walk(at)
		if (obj === null) throw oops('ENOENT', at)
		return obj
	}

	const statOf = (obj: Obj): BigIntStats => {
		const type = obj.kind === 'dir' ? S_IFDIR : obj.kind === 'symlink' ? S_IFLNK : S_IFREG
		const size = BigInt(obj.kind === 'file' ? (obj.data?.length ?? 0) : (obj.kids?.size ?? 0))
		return {
			ino: obj.ino,
			mode: BigInt(type | obj.perm),
			mtimeNs: obj.mtimeNs,
			ctimeNs: obj.ctimeNs,
			size,
			isDirectory: () => obj.kind === 'dir',
			isSymbolicLink: () => obj.kind === 'symlink',
			isFile: () => obj.kind === 'file'
		} as unknown as BigIntStats
	}

	/** Adding, removing or renaming an entry moves the directory's own mtime. */
	const stirredBy = (dir: Obj): void => {
		dir.mtimeNs = now()
		dir.ctimeNs = now()
	}

	/** WRITE and SEARCH on the directory an entry is going into or out of. */
	const enterable = (dir: Obj, at: Spot): void => {
		if ((dir.perm & (WRITE | SEARCH)) !== (WRITE | SEARCH)) throw oops('EACCES', at)
	}

	const put = (at: Spot, make: (was: Obj | null) => Obj): void => {
		const { obj, dir, name } = walk(at)
		if (dir === null) throw oops('EINVAL', at)
		enterable(dir, at)
		dir.kids?.set(name, make(obj))
		stirredBy(dir)
		stirred(at)
	}

	const take = (at: Spot): Obj | null => {
		const { obj, dir, name } = walk(at)
		if (obj === null || dir === null) return null
		enterable(dir, at)
		dir.kids?.delete(name)
		stirredBy(dir)
		stirred(at)
		return obj
	}

	const quiet = async <T>(work: () => T, fallback: T): Promise<T> => {
		try {
			return work()
		} catch {
			return fallback
		}
	}

	const mine = async (was: Seen): Promise<boolean> => {
		const s = await quiet(() => statOf(must(was.path)), null)
		return s !== null && String(s.ino) === was.ino
	}

	/** Directories a pass opened, closed again by the pass that opened them. */
	const opened = new Set<NodeId>()

	/** Every name on the way, and an existing directory is not an error. */
	const makeDir = (at: Spot): void => {
		if (at === AT_ROOT) return
		let dir = root
		for (const name of at.split('/')) {
			if (dir.kind !== 'dir') throw oops('ENOTDIR', at)
			const next = dir.kids?.get(name)
			if (next !== undefined) {
				dir = next
				continue
			}
			enterable(dir, at)
			const made: Obj = {
				ino: inos++,
				kind: 'dir',
				perm: 0o755,
				mtimeNs: now(),
				ctimeNs: now(),
				kids: new Map()
			}
			dir.kids?.set(name, made)
			stirredBy(dir)
			dir = made
		}
		stirred(at)
	}

	return {
		root: AT_ROOT,
		under,
		up,
		spot,

		stat: (at) =>
			quiet(() => {
				check('stat', at)
				return statOf(must(at))
			}, null),

		async absent(at) {
			try {
				check('stat', at)
				must(at)
				return false
			} catch (e) {
				const code = (e as NodeJS.ErrnoException).code
				return code === 'ENOENT' || code === 'ENOTDIR'
			}
		},

		list: (at) =>
			quiet(() => {
				check('list', at)
				const obj = must(at)
				if (obj.kind !== 'dir') throw oops('ENOTDIR', at)
				// Listing is what READ is for, and it is not what SEARCH gives.
				if ((obj.perm & READ) !== READ) throw oops('EACCES', at)
				return [...(obj.kids?.keys() ?? [])]
			}, null),

		async bytes(at, strict) {
			try {
				check('read', at)
				const obj = must(at)
				if (obj.kind === 'dir') throw oops('EISDIR', at)
				return new Uint8Array(obj.data ?? new Uint8Array())
			} catch (e) {
				if (strict && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
				return null
			}
		},

		target: (at) =>
			quiet(() => {
				const obj = must(at)
				if (obj.kind !== 'symlink') throw oops('EINVAL', at)
				return obj.link ?? ''
			}, null),

		mine,

		async write(at, data) {
			check('write', at)
			put(at, () => ({
				// A publish takes the name with a rename, so what lands is a NEW object —
				// a new inode, and the mode a fresh file gets. That is the whole reason a
				// stamp has to follow every write, and a test that reused the old inode
				// here would never see it.
				ino: inos++,
				kind: 'file',
				perm: 0o644,
				mtimeNs: now(),
				ctimeNs: now(),
				data: new Uint8Array(data)
			}))
		},

		async link(at, target) {
			check('link', at)
			put(at, () => ({
				ino: inos++,
				kind: 'symlink',
				perm: 0o777,
				mtimeNs: now(),
				ctimeNs: now(),
				link: target
			}))
		},

		async dir(at) {
			check('dir', at)
			makeDir(at)
		},

		async stamp(at, how) {
			check('stamp', at)
			const obj = must(at)
			// A symlink's own mode is not settable on every platform, and nothing reads
			// it — the same carve-out the real one makes.
			if (!how.symlink) {
				obj.perm = how.mode & 0o7777
				obj.ctimeNs = now()
			}
			if (how.mtimeNs === undefined) return
			// A `Date` carries milliseconds, so that is all a stamp can write. The store
			// knows this and forgives the difference (`rounded`); it has to be real here
			// or that forgiveness is never exercised.
			obj.mtimeNs = (how.mtimeNs / 1_000_000n) * 1_000_000n
			obj.ctimeNs = now()
		},

		async move(was, to) {
			check('move', to)
			if (!(await mine(was))) return false
			const obj = take(was.path)
			if (obj === null) return false
			put(to, () => obj)
			// A rename moves the ctime of the thing renamed, and nothing else about it.
			obj.ctimeNs = now()
			return true
		},

		async drop(was, holding, directory) {
			check('drop', was.path)
			if (!(await mine(was))) return
			if (!directory) {
				take(was.path)
				return
			}
			// Taken aside under a name nobody else knows, identified there, and only then
			// removed — the same two-step the real one does, for the same reason.
			const aside = under(holding, `going-${inos++}`)
			if (aside === null) return
			makeDir(holding)
			const moved = await quiet(() => {
				const obj = take(was.path)
				if (obj === null) return false
				put(aside, () => obj)
				return true
			}, false)
			if (!moved) {
				await quiet(() => take(was.path), null)
				return
			}
			const s = await quiet(() => statOf(must(aside)), null)
			if (s !== null && String(s.ino) === was.ino) {
				await quiet(() => take(aside), null)
				return
			}
			await quiet(() => {
				const obj = take(aside)
				if (obj !== null) put(was.path, () => obj)
				return null
			}, null)
		},

		prune: (at) =>
			quiet(() => {
				const obj = must(at)
				if (obj.kind !== 'dir' || (obj.kids?.size ?? 0) > 0) return false
				return take(at) !== null
			}, false),

		async clear(at) {
			await quiet(() => take(at), null)
		},

		async unlock(steps) {
			for (const step of steps) {
				const obj = await quiet(() => must(step.spot), null)
				if (obj === null) continue
				// Identity, where the caller knew one: another process may have put a
				// different directory at this name, and that one is not this store's.
				if (step.ino !== undefined && String(obj.ino) !== step.ino) continue
				opened.add(step.id)
				obj.perm = (step.mode & 0o7777) | step.need
				obj.ctimeNs = now()
			}
		},

		async relock(resolve) {
			const out = []
			for (const id of [...opened].reverse()) {
				const was = resolve(id)
				if (was === null) continue
				const obj = await quiet(() => must(was.spot), null)
				if (obj === null || String(obj.ino) !== was.ino) continue
				obj.perm = was.mode & 0o7777
				obj.ctimeNs = now()
				out.push({ id, ino: was.ino, state: stateOf(statOf(obj)) })
			}
			opened.clear()
			return out
		},

		get held() {
			return opened.size > 0
		},

		watch(onPath) {
			listener = onPath
			return () => {
				listener = null
			}
		},

		where: (at) => `mem:/${at}`
	}
}

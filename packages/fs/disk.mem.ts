/**
 * A `Disk` that is not a disk. The same tree, the same inodes, the same permission
 * rules, in memory — so `fsStore` can be run thousands of times a second,
 * deterministically, with faults injected wherever a test wants one. It exists for the
 * oracle in `store.fs.model.test.ts`: a property test that has to make real files does a
 * few hundred cases before CI notices, and every one is at the mercy of the host’s
 * timestamp granularity.
 *
 * The rules it keeps, because they are the ones the findings were about:
 *
 * - **Permissions.** SEARCH to walk through a directory, READ to list one, WRITE and
 *   SEARCH to add or remove an entry. A denial is `EACCES`, not "nothing there".
 * - **Identity.** Every object has an inode, minted once, and a rename carries it.
 * - **Time.** A counter, not a clock. `ctime` moves on every change and cannot be set;
 *   `stamp` writes an mtime rounded to the millisecond, which is all a `Date` carries
 *   and therefore all the real backend can write either.
 *
 * Where it differs, it differs on the strict side: a symlink in the MIDDLE of a path is
 * not followed here, so a path through one fails instead of resolving. There is no
 * outside for it to resolve to — the escape that matters about a symlinked ancestor can
 * only be shown against a real filesystem, and is (`store.fs.test.ts`).
 */

import type { BigIntStats } from 'node:fs'
import {
	AT_ROOT,
	type Disk,
	READ,
	SEARCH,
	type Seen,
	type Spot,
	type Stamp,
	stateOf,
	unchanged,
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

	const look = (at: Spot): Promise<BigIntStats | null> => quiet(() => statOf(must(at)), null)

	const mine = async (was: Seen): Promise<boolean> => {
		const s = await look(was.path)
		return s !== null && String(s.ino) === was.ino
	}

	/** What a change left at a name, and null while the name holds something else. */
	const seenAt = async (at: Spot, ino?: bigint): Promise<Seen | null> => {
		const s = await look(at)
		if (s === null || (ino !== undefined && s.ino !== ino)) return null
		return { path: at, ino: String(s.ino), state: stateOf(s) }
	}

	const stampOn = (obj: Obj, how: Stamp): void => {
		// A symlink's own mode is not settable on every platform, and nothing reads it —
		// the same carve-out the real one makes.
		if (!how.symlink) {
			obj.perm = how.mode & 0o7777
			obj.ctimeNs = now()
		}
		if (how.mtimeNs === undefined) return
		// A `Date` carries milliseconds, so that is all a stamp can write. The store knows
		// this and forgives the difference (`rounded`); it has to be real here or that
		// forgiveness is never exercised.
		obj.mtimeNs = (how.mtimeNs / 1_000_000n) * 1_000_000n
		obj.ctimeNs = now()
	}

	/** Is the name still holding what the caller observed there? */
	const still = async (was: Seen): Promise<boolean> => {
		const s = await look(was.path)
		return s !== null && unchanged(was, s)
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

		async write(at, data, on, was) {
			check('write', at)
			// The same condition the real one applies, and at the same moment: what the
			// caller observed is still what the name holds, or these bytes are not its
			// write to make.
			if (was !== undefined && !(await still(was))) return null
			let ino = 0n
			put(at, () => {
				// A publish takes the name with a rename, so what lands is a NEW object — a
				// new inode, and the mode a fresh file gets. A test that reused the old inode
				// here would never see the checks that exist because it does not.
				const made: Obj = {
					ino: inos++,
					kind: 'file',
					perm: 0o644,
					mtimeNs: now(),
					ctimeNs: now(),
					data: new Uint8Array(data)
				}
				// Stamped before it has a name, like the real one: what arrives is already
				// the object the row describes.
				if (on !== undefined) stampOn(made, on)
				ino = made.ino
				return made
			})
			return seenAt(at, ino)
		},

		async link(at, target, on) {
			check('link', at)
			let ino = 0n
			put(at, () => {
				const made: Obj = {
					ino: inos++,
					kind: 'symlink',
					perm: 0o777,
					mtimeNs: now(),
					ctimeNs: now(),
					link: target
				}
				if (on !== undefined) stampOn(made, on)
				ino = made.ino
				return made
			})
			return seenAt(at, ino)
		},

		async dir(at) {
			check('dir', at)
			makeDir(at)
			return seenAt(at)
		},

		async stamp(at, how, was) {
			check('stamp', at)
			if (was !== undefined && !(await still(was))) return null
			const size = statOf(must(at)).size
			stampOn(must(at), how)
			// The same second look the real one takes: the stamp moves the object's own
			// fields, so anything else having moved is somebody else.
			const after = await seenAt(at, was === undefined ? undefined : BigInt(was.ino))
			return after !== null && statOf(must(at)).size === size ? after : null
		},

		async move(was, to) {
			check('move', to)
			// The whole observation, like the real one: an in-place edit keeps the inode.
			if (!(await still(was))) return null
			// And the far end, like the real one: the name has been freed by the caller, so
			// anything at it now is somebody else's and is not this move's to replace.
			if ((await look(to)) !== null) return null
			const obj = take(was.path)
			if (obj === null) return null
			put(to, () => obj)
			// A rename moves the ctime of the thing renamed, and nothing else about it.
			obj.ctimeNs = now()
			return seenAt(to, obj.ino)
		},

		async drop(was, _holding, _directory) {
			check('drop', was.path)
			// No two-step: the real one takes a directory aside because another process can put
			// something else at the path between a look and a removal, and nothing here has
			// another process. Faking it would fake the implementation, not the behaviour.
			if (!(await mine(was))) return
			await quiet(() => take(was.path), null)
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

		watch(onPath) {
			listener = onPath
			return () => {
				listener = null
			}
		}
	}
}

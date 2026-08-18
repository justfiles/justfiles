/**
 * The disk, and the only thing that touches it. `store.fs.ts` decides WHAT should be
 * where; this decides how a location is named, whether it is inside the store, and
 * whether the thing at it is still the thing the caller meant.
 *
 * - **A location is a `Spot`, and only this module makes one** — from `AT_ROOT`, `under`
 *   (one validated name at a time) or `spot` (re-validating text out of the sidecar). A
 *   row from a peer, an id used as a path, or a tampered index cannot address anything
 *   outside the tree, because there is no second path into `join`.
 * - **Identity is the inode.** Every call that changes or removes takes the `Seen` the
 *   caller believes in, and does nothing if the disk no longer holds that inode.
 * - **A way in is granted and taken back by the same pass.** A directory whose mode
 *   shuts this store out is opened for as long as the pass needs it (`unlock`) and put
 *   back as the pass's last act (`relock`).
 */

import { type BigIntStats, watch as watchPath } from 'node:fs'
import {
	chmod,
	lstat as lstatOf,
	lutimes,
	mkdir,
	open as openPath,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	rmdir,
	symlink,
	writeFile
} from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { NodeId } from './store'

const NUL = String.fromCharCode(0)

declare const Inside: unique symbol

/**
 * Somewhere inside the store root, relative to it; `''` is the root. Only this module
 * mints one, which makes "inside" a fact about the type rather than a check to remember.
 */
export type Spot = string & { readonly [Inside]: true }

/** What the caller last saw at a spot, and how it will know the thing again. */
export type Seen = { path: Spot; ino: string; state: string; hash?: string }

/** A directory on the way in, and what it must grant before the pass can pass. */
export type Step = { id: NodeId; spot: Spot; mode: number; ino?: string; need: number }

/** What `relock` observed putting a mode back: the state to record for that row. */
export type Relocked = { id: NodeId; ino: string; state: string }

export const READ = 0o400
export const WRITE = 0o200
export const SEARCH = 0o100

/**
 * A name that is not a name: empty, `.`, `..`, a separator, or NUL. `sep` as well as `/`
 * because a platform may separate on something else — on Windows `..\victim` resolves
 * clean out of the root while reading as one name. `node:fs` refuses a NUL outright, so
 * a page carrying one must not be a page this replica can never apply.
 */
export const unsafe = (name: string): boolean =>
	name === '' ||
	name === '.' ||
	name === '..' ||
	name.includes('/') ||
	name.includes(sep) ||
	name.includes(NUL)

/**
 * Everything a write to a file changes — and `ctimeNs`, the one no writer can put back.
 * A metadata-preserving sync can restore mode, mtime and size over somebody else's
 * bytes; the ctime moves on any change to the inode and userland cannot set it.
 */
export const stateOf = (s: BigIntStats): string => `${s.mode}:${s.mtimeNs}:${s.size}:${s.ctimeNs}`

/** Is this still the file the row was observed at, in the state it was in? */
export const unchanged = (was: Seen, s: BigIntStats): boolean =>
	was.ino === String(s.ino) && was.state === stateOf(s)

/**
 * What a row states about its object, on the object. `lutimes`, so a symlink gets its
 * own stamp rather than its target's; milliseconds, because that is what a `Date` holds.
 */
export type Stamp = {
	mode: number
	/** Left out to set the mode alone — a directory's stamp waits for its entries. */
	mtimeNs?: bigint
	symlink?: boolean
}

/** The root: the one spot that needs no name to reach. */
export const AT_ROOT = '' as Spot

/** One name deeper, or null when the name is not a name. */
export const under = (parent: Spot, name: string): Spot | null =>
	unsafe(name) ? null : ((parent === AT_ROOT ? name : `${parent}/${name}`) as Spot)

/** One name shallower. Root is its own parent, and the walk stops there. */
export const up = (at: Spot): Spot => {
	const cut = at.lastIndexOf('/')
	return (cut === -1 ? '' : at.slice(0, cut)) as Spot
}

/**
 * Text that claims to be a spot — out of the sidecar, which is a file anybody can edit.
 * Checked name by name, so one bad component makes the whole thing no spot at all.
 */
export const spot = (text: string): Spot | null => {
	if (text === '') return AT_ROOT
	for (const name of text.split('/')) if (unsafe(name)) return null
	return text as Spot
}

/**
 * Somewhere to read and write. Naming is not here: `AT_ROOT`, `under`, `up` and `spot`
 * are the same for every disk, and the I/O is the only part worth faking.
 */
export interface Disk {
	// ── Looking ────────────────────────────────────────────────────────────────
	stat(spot: Spot): Promise<BigIntStats | null>
	/** Is there NOTHING here — as opposed to nothing this store can see? */
	absent(spot: Spot): Promise<boolean>
	list(spot: Spot): Promise<string[] | null>
	/**
	 * A whole file, or null when there is nothing there. `strict` decides what "nothing
	 * there" may mean: lenient (the default) is for content, where unreadable and absent
	 * are both "no bytes"; strict is for anything this store REASONS from — null only for
	 * a file genuinely not there, every other error thrown.
	 */
	bytes(spot: Spot, strict?: boolean): Promise<Uint8Array | null>
	target(spot: Spot): Promise<string | null>
	/** Does the disk still hold the file this row named? Identity is the inode. */
	mine(at: Seen): Promise<boolean>

	// ── Changing ───────────────────────────────────────────────────────────────
	/**
	 * Bytes into a name in ONE operation: built beside it, then renamed over it.
	 *
	 * `at` is put on the payload BEFORE it takes the name, so what arrives is already the
	 * object the row describes — there is no moment where the name holds a file wearing
	 * `writeFile`'s mode, and nothing to stamp afterwards on whatever answers by then.
	 *
	 * `was` makes it conditional — the bytes land only while the disk still holds what
	 * the caller observed there, and false is somebody else's having arrived instead.
	 * The whole state and not just the inode: `echo x > f` truncates in place, so a
	 * check that only asked whose inode it was would miss the commonest edit there is.
	 * Asked immediately before the rename, so the window is two adjacent calls rather
	 * than however long the payload took to write.
	 */
	write(spot: Spot, data: Uint8Array, at?: Stamp, was?: Seen): Promise<boolean>
	/** A symlink into a name, the same way. */
	link(spot: Spot, target: string, at?: Stamp): Promise<void>
	/** This directory and every one above it. */
	dir(spot: Spot): Promise<void>
	/** What a row states about its object, on the object. */
	stamp(spot: Spot, at: Stamp): Promise<void>

	/**
	 * Rename, but only while the disk still holds the caller's inode. False is the file
	 * having become somebody else's, never an error.
	 */
	move(at: Seen, to: Spot): Promise<boolean>

	/**
	 * Remove what a row named, while the disk still holds THAT file. A directory is
	 * taken aside first and identified where nothing can be swapped under it.
	 */
	drop(at: Seen, holding: Spot, directory: boolean): Promise<void>

	/** Remove this directory if it is empty. Says whether it went. */
	prune(spot: Spot): Promise<boolean>

	/**
	 * Remove whatever is here, whoever it belongs to. The one unchecked removal, and it
	 * exists for one caller: a leftover in the holding area, which no row can be under.
	 */
	clear(spot: Spot): Promise<void>

	// ── Ways in ────────────────────────────────────────────────────────────────
	/**
	 * Open every directory on the way that does not already grant what the pass needs —
	 * outside in, since an ancestor must be open before the `chmod` below it can land.
	 */
	unlock(steps: Step[]): Promise<void>

	/**
	 * The stated mode back on everything this pass opened, innermost first. Never throws:
	 * it runs on the way out of passes that are themselves leaving by way of an error.
	 * Hands back what it observed, so the caller can record a state its own chmod moved.
	 *
	 * Where each one is NOW is asked of the caller at this moment rather than remembered
	 * from `unlock`: the pass may have renamed the directory, or changed the mode its row
	 * states. Null drops it.
	 */
	relock(
		resolve: (id: NodeId) => { spot: Spot; ino: string; mode: number } | null
	): Promise<Relocked[]>

	/**
	 * Ask the OS where to look. An event is a hint, so the type is dropped and only the
	 * spot passed on; `lost` means the watcher is gone or said something it could not
	 * name. Null when this platform, filesystem or watch budget has none.
	 */
	watch(onPath: (spot: Spot) => void, onLost: () => void): (() => void) | null
}

export function fsDisk(rootPath: string): Disk {
	const abs = (at: Spot): string => (at === AT_ROOT ? rootPath : join(rootPath, at))

	const lstat = (at: Spot): Promise<BigIntStats | null> =>
		lstatOf(abs(at), { bigint: true }).catch(() => null)

	/**
	 * Take a name in one operation: build the payload under a private sibling, then rename
	 * it over the target. POSIX has no atomic content write, so a reader that resolves the
	 * name mid-`write` reads a prefix of it. A SIBLING, because `rename` cannot cross a
	 * filesystem and a tree can have another mount underneath it.
	 */
	const publish = async (
		spot: Spot,
		build: (tmp: string) => Promise<void>,
		at?: Stamp,
		was?: Seen
	): Promise<boolean> => {
		const os = abs(spot)
		const tmp = `${os}.jfs-${crypto.randomUUID()}`
		try {
			await build(tmp)
			if (at !== undefined) await stampAt(tmp, at)
			if (was !== undefined) {
				const s = await lstat(spot)
				if (s === null || !unchanged(was, s)) return false
			}
			await rename(tmp, os)
			return true
		} finally {
			// The whole lifecycle, not just the rename: a write that failed halfway would
			// otherwise strand its temp file.
			await rm(tmp, { force: true })
		}
	}

	/**
	 * A mode set on the directory this store MEANT, not on whatever answers to its name by
	 * the time the call lands: opened, identified and changed through the one descriptor.
	 * Only where the mode still allows opening it — POSIX wants the read bit to open a
	 * directory, which `0300`, `0100` and `0000` do not give even to their owner, and there
	 * is no `fchmodat` here. Those fall back to the name, raced at worst.
	 */
	const setMode = async (spot: Spot, ino: string, mode: number): Promise<BigIntStats | null> => {
		const handle = await openPath(abs(spot)).catch(() => null)
		if (handle === null) {
			const s = await lstat(spot)
			if (s === null || String(s.ino) !== ino) return null
			await chmod(abs(spot), mode)
			// The name is all this fallback has, so it asks again rather than assume.
			const now = await lstat(spot)
			return now !== null && String(now.ino) === ino ? now : null
		}
		try {
			const s = await handle.stat({ bigint: true })
			if (String(s.ino) !== ino) return null
			await handle.chmod(mode)
			// Through the same descriptor, so this is the state of the inode that changed.
			return await handle.stat({ bigint: true })
		} finally {
			await handle.close()
		}
	}

	const stampAt = async (os: string, at: Stamp): Promise<void> => {
		// A symlink's own mode is not settable on every platform, and nothing reads it.
		if (!at.symlink) await chmod(os, at.mode & 0o7777)
		if (at.mtimeNs === undefined) return
		const when = new Date(Number(at.mtimeNs / 1_000_000n))
		await lutimes(os, when, when)
	}

	/** Directories opened for a pass, closed again by the pass that opened them. */
	const opened = new Set<NodeId>()

	const mine = async (at: Seen): Promise<boolean> => {
		const s = await lstat(at.path)
		return s !== null && String(s.ino) === at.ino
	}

	return {
		stat: lstat,

		async absent(spot) {
			// Only "no such entry" is gone. Anything else is this store unable to look, and a
			// tombstone for a file that is still there loses it for every replica.
			const gone = await lstatOf(abs(spot)).then(
				() => null,
				(e: NodeJS.ErrnoException) => e.code
			)
			return gone === 'ENOENT' || gone === 'ENOTDIR'
		},

		list: (spot) => readdir(abs(spot)).catch(() => null),

		bytes: (spot, strict) =>
			readFile(abs(spot))
				// Not the `Buffer` node hands back: the seam says `Uint8Array`.
				.then((b) => new Uint8Array(b))
				.catch((e: NodeJS.ErrnoException) => {
					if (strict && e.code !== 'ENOENT') throw e
					return null
				}),

		target: (spot) => readlink(abs(spot)).catch(() => null),

		mine,

		write: (spot, data, at, was) => publish(spot, (tmp) => writeFile(tmp, data), at, was),

		link: async (spot, target, at) => void (await publish(spot, (tmp) => symlink(target, tmp), at)),

		async dir(spot) {
			await mkdir(abs(spot), { recursive: true })
		},

		stamp: (spot, at) => stampAt(abs(spot), at),

		async move(at, to) {
			if (!(await mine(at))) return false
			await rename(abs(at.path), abs(to))
			return true
		},

		async drop(at, holding, directory) {
			if (!(await mine(at))) return
			if (!directory) {
				await rm(abs(at.path), { force: true })
				return
			}
			// Looking and removing are two calls, and a name can change hands between them: a
			// recursive `rm` aimed at whatever arrived in that window would take a subtree this
			// store never had. So it moves to a name nobody else knows — one call — and is
			// identified there. Not the row’s, and it goes back.
			const aside = under(holding, `going-${crypto.randomUUID()}`)
			if (aside === null) return
			await mkdir(abs(holding), { recursive: true })
			const moved = await rename(abs(at.path), abs(aside)).then(
				() => true,
				() => false
			)
			// A rename that cannot happen — another filesystem mounted under this tree.
			if (!moved) {
				await rm(abs(at.path), { recursive: true, force: true })
				return
			}
			const s = await lstat(aside)
			if (s !== null && String(s.ino) === at.ino) {
				await rm(abs(aside), { recursive: true, force: true })
				return
			}
			await rename(abs(aside), abs(at.path)).catch(() => {})
		},

		prune: (spot) =>
			rmdir(abs(spot)).then(
				() => true,
				() => false
			),

		async clear(spot) {
			await rm(abs(spot), { recursive: true, force: true })
		},

		async unlock(steps) {
			for (const step of steps) {
				opened.add(step.id)
				const mode = (step.mode & 0o7777) | step.need
				// No `ino` when this store has just made the directory itself; the marking that
				// records its identity comes after.
				if (step.ino === undefined) await chmod(abs(step.spot), mode)
				else await setMode(step.spot, step.ino, mode)
			}
		},

		async relock(resolve) {
			const out: Relocked[] = []
			for (const id of [...opened].reverse()) {
				const was = resolve(id)
				if (was === null) continue
				// Never throws: this runs on the way out of a pass that may itself be leaving by
				// way of an error, and that is the error the caller has to see.
				try {
					// The same inode this pass opened, or nothing at all: another process may have
					// left a different directory at the name, and restricting THAT one would be this
					// store changing something it never touched.
					const s = await setMode(was.spot, was.ino, was.mode & 0o7777)
					if (s !== null) out.push({ id, ino: was.ino, state: stateOf(s) })
				} catch {}
			}
			opened.clear()
			return out
		},

		watch(onPath, onLost) {
			try {
				// `persistent: false`, so a CLI that never closes the store still exits; events
				// keep arriving while the process has other work.
				const held = watchPath(rootPath, { recursive: true, persistent: false }, (_type, name) => {
					if (name === null) {
						onLost()
						return
					}
					// The OS spells a path in the platform's separator, and may name something this
					// store would never make. An event nobody can address is an event to drop.
					const at = spot(String(name).split(sep).join('/'))
					if (at !== null) onPath(at)
				})
				held.on('error', onLost)
				return () => held.close()
			} catch {
				// No watcher on this platform, this filesystem, or past this many watches (Linux
				// counts them per directory). The tree gets walked instead.
				return null
			}
		}
	}
}

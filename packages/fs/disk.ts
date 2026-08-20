/**
 * The disk, and the only thing that touches it. `fs.ts` decides WHAT should be
 * where; this decides how a location is named, whether it is inside the store, and
 * whether the thing at it is still the thing the caller meant.
 *
 * - **A location is a `Spot`, and only this module makes one** — from `AT_ROOT`, `under`
 *   (one validated name at a time) or `spot` (re-validating text out of the sidecar). A
 *   row from a peer, an id used as a path, or a tampered index cannot address anything
 *   outside the tree, because there is no second path into `join`.
 * - **Identity is the inode**, and the whole observation wherever a call has to vouch for
 *   what it left: every call that changes or removes takes the `Seen` the caller believes
 *   in, and does nothing once the disk has stopped holding it.
 * - **A way in is granted and taken back by the same pass.** A directory whose mode
 *   shuts this store out is opened for as long as the pass needs it (`unlock`) and put
 *   back as the pass's last act (`relock`).
 */

import { type BigIntStats, constants, watch as watchPath } from 'node:fs'
import {
	chmod,
	lstat as lstatOf,
	lutimes,
	mkdir,
	open as openPath,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	rmdir,
	symlink,
	writeFile
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { NodeId } from './store'

const NUL = String.fromCharCode(0)

const { O_RDONLY } = constants
/** Not defined on every platform, and an undefined flag would poison the open. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

declare const Inside: unique symbol

/**
 * Somewhere inside the store root, relative to it; `''` is the root. Only this module
 * mints one, which makes "inside" a fact about the type rather than a check to remember.
 */
export type Spot = string & { readonly [Inside]: true }

/** What the caller last saw at a spot, and how it will know the thing again. */
export type Seen = { path: Spot; ino: string; state: string; hash?: string }

/**
 * What the caller last saw at the name it is about to take — or `unseen`, which it has to
 * say out loud. Every act that takes a name asks for one, and none of them defaults: an
 * unconditional write is a claim written in the code, not an argument somebody left off.
 * That is the whole of the difference. The rule was always this; making it a parameter
 * with no default is what stops a call site quietly opting out of it.
 */
export type Held = Seen | 'unseen'

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
	// Every call that LEAVES something hands back what it left, and null when it left
	// nothing: refused as outside the tree, or the name was somebody else's by the time it
	// landed. The observation is taken here, beside the act — a caller that looked
	// afterwards would be describing whatever answered by then, and there is no way for it
	// to record a belief this module did not give it. A removal has nothing to hand back.
	//
	// And every one of them takes a `Held`, required: what the caller saw at the name, or
	// `unseen`. There is no third option and no default, so no act can go in unconditional
	// by omission — only by saying so.

	/**
	 * Bytes into a name in ONE operation: built beside it, then renamed over it.
	 *
	 * `at` is put on the payload BEFORE it takes the name, so what arrives is already the
	 * object the row describes — there is no moment where the name holds a file wearing
	 * `writeFile`'s mode, and nothing to stamp afterwards on whatever answers by then.
	 *
	 * `was` makes it conditional — the bytes land only while the disk still holds what
	 * the caller observed there. The whole state and not just the inode: `echo x > f`
	 * truncates in place, so a check that only asked whose inode it was would miss the
	 * commonest edit there is. Asked immediately before the rename, so the window is two
	 * adjacent calls rather than however long the payload took to write.
	 */
	write(spot: Spot, data: Uint8Array, at: Stamp | undefined, was: Held): Promise<Seen | null>
	/** A symlink into a name, the same way — `was` and all: a target is content too. */
	link(spot: Spot, target: string, at: Stamp | undefined, was: Held): Promise<Seen | null>
	/** This directory and every one above it. */
	dir(spot: Spot): Promise<Seen | null>
	/**
	 * What a row states about its object, on the object. `was` makes it conditional the
	 * way `write`'s does, and the stamp is its own second look: it moves mode, mtime and
	 * ctime, so nothing else about the thing may have — another inode is somebody's
	 * replacement, another size is somebody's write.
	 */
	stamp(spot: Spot, at: Stamp, was: Held): Promise<Seen | null>

	/**
	 * Rename, but only while the disk still holds what the caller observed — the whole of
	 * it, because the state it left with is the baseline the far end is held to — and only
	 * onto a name nothing holds. A caller frees the name first; anything at it by now is
	 * somebody else's, and a rename over it would be a removal nobody asked for.
	 */
	move(at: Seen, to: Spot): Promise<Seen | null>

	/**
	 * Remove what a row named, while the disk still holds it as the caller saw it. A FILE
	 * is held to its whole state, the way every other conditional act holds one: an
	 * in-place write keeps the inode, so identity alone would `rm` the writer's only copy.
	 *
	 * A DIRECTORY goes by `rmdir`, which is the one removal here with no window at all:
	 * POSIX refuses it on a directory holding anything, so whatever arrived since the
	 * caller looked keeps the directory standing instead of going with it. The caller only
	 * ever aims this at one it believes empty — a subtree with rows in it is parked, not
	 * removed — so nothing here needs to recurse, and nothing recursive can be aimed
	 * wrong. Its identity is checked first all the same: an empty directory somebody else
	 * put at the name is not this store's to take.
	 */
	drop(at: Seen, directory: boolean): Promise<void>

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

	/** The root with every link in it already resolved, asked once. */
	let base: Promise<string> | null = null
	const rootReal = (): Promise<string> =>
		(base ??= realpath(rootPath).catch(() => resolve(rootPath)))

	/**
	 * Does this path still lead inside the root? `O_NOFOLLOW` guards the last component
	 * only, and Node has no `openat` to walk the rest one at a time with — so an ancestor a
	 * local tool has turned into a link out of the tree takes every by-name call with it.
	 * `realpath` resolves the whole way, which catches it wherever it sits.
	 *
	 * The way TO the name, not the name: `rename`, `rm` and `lutimes` act on a link rather
	 * than through it, so a leaf that is one is the caller's business and `O_NOFOLLOW` is
	 * what guards the calls that would follow it. The deepest ancestor that EXISTS is what
	 * gets asked, because a path about to be created has none of itself yet. Check-then-act like everything else here: a swap landing
	 * between this and the call it guards still wins. What it buys is that an escape has to
	 * win a race rather than simply be left lying there.
	 */
	const inside = async (os: string): Promise<boolean> => {
		// The root is inside itself, and what sits above it was never this store's business.
		if (resolve(os) === resolve(rootPath)) return true
		const root = await rootReal()
		for (let at = dirname(os); ; at = dirname(at)) {
			const real = await realpath(at).catch(() => null)
			if (real !== null) return real === root || real.startsWith(root + sep)
			if (dirname(at) === at) return false
		}
	}

	const lstat = (at: Spot): Promise<BigIntStats | null> =>
		lstatOf(abs(at), { bigint: true }).catch(() => null)

	const seenAt = async (spot: Spot): Promise<Seen | null> => {
		const s = await lstat(spot)
		return s === null ? null : { path: spot, ino: String(s.ino), state: stateOf(s) }
	}

	/**
	 * What a rename carries over unchanged. The ctime is the one field it moves itself, so
	 * it is the one field that says nothing about whether anybody else got in.
	 */
	const carried = (s: BigIntStats): string => `${s.mode}:${s.mtimeNs}:${s.size}`

	/**
	 * The state at a spot, but only while it still holds the very thing this call put
	 * there. What arrived and what is at the name a syscall later are two different
	 * questions, and handing back somebody else's state under this call's name is the
	 * whole failure. The inode alone is not enough: `echo x > f` truncates in place and
	 * keeps it, so the payload is held to everything the rename carried as well.
	 */
	const held = async (spot: Spot, made: BigIntStats): Promise<Seen | null> => {
		const s = await lstat(spot)
		if (s === null || s.ino !== made.ino || carried(s) !== carried(made)) return null
		return { path: spot, ino: String(s.ino), state: stateOf(s) }
	}

	/**
	 * Take a name in one operation: build the payload under a private sibling, then rename
	 * it over the target. POSIX has no atomic content write, so a reader that resolves the
	 * name mid-`write` reads a prefix of it. A SIBLING, because `rename` cannot cross a
	 * filesystem and a tree can have another mount underneath it.
	 */
	const publish = async (
		spot: Spot,
		build: (tmp: string) => Promise<void>,
		at: Stamp | undefined,
		was: Held
	): Promise<Seen | null> => {
		const os = abs(spot)
		if (!(await inside(os))) return null
		const tmp = `${os}.jfs-${crypto.randomUUID()}`
		try {
			await build(tmp)
			if (at !== undefined && !(await stampAt(tmp, at))) return null
			// The payload's own inode, learned while its name is still one nobody else has.
			// `rename` carries it to the target, so this is what the caller was given.
			const made = await lstatOf(tmp, { bigint: true }).catch(() => null)
			if (made === null) return null
			if (was !== 'unseen') {
				const s = await lstat(spot)
				if (s === null || !unchanged(was, s)) return null
			}
			await rename(tmp, os)
			return held(spot, made)
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
		if (!(await inside(abs(spot)))) return null
		const handle = await openPath(abs(spot), O_RDONLY | NOFOLLOW).catch(() => null)
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

	/**
	 * A mode on the thing AT this name, never on what it points to. `chmod` resolves a
	 * symlink, so a name a local tool has turned into one is a way for this store to change
	 * a file outside the tree it was given entirely — `Spot` says where a name IS, and
	 * nothing about what it resolves to. Opened `O_NOFOLLOW` and changed through the
	 * descriptor, so a link is refused rather than walked.
	 *
	 * The fallback is for the one thing that cannot be opened: a directory whose own mode
	 * shuts this store out (`0300`, `0100`, `0000`). It asks the name what it is first, and
	 * a link is left alone — raced at worst, where before it was followed at leisure.
	 */
	const modeAt = async (os: string, mode: number): Promise<boolean> => {
		if (!(await inside(os))) return false
		const handle = await openPath(os, O_RDONLY | NOFOLLOW).catch(() => null)
		if (handle === null) {
			const s = await lstatOf(os).catch(() => null)
			if (s === null || s.isSymbolicLink()) return false
			await chmod(os, mode)
			return true
		}
		try {
			await handle.chmod(mode)
			return true
		} finally {
			await handle.close()
		}
	}

	const stampAt = async (os: string, at: Stamp): Promise<boolean> => {
		// A symlink's own mode is not settable on every platform, and nothing reads it.
		if (!at.symlink && !(await modeAt(os, at.mode & 0o7777))) return false
		if (at.mtimeNs === undefined) return true
		// `lutimes` does not follow the last component, and follows every one before it.
		if (!(await inside(os))) return false
		const when = new Date(Number(at.mtimeNs / 1_000_000n))
		await lutimes(os, when, when)
		return true
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

		link: (spot, target, at, was) => publish(spot, (tmp) => symlink(target, tmp), at, was),

		async dir(spot) {
			if (!(await inside(abs(spot)))) return null
			await mkdir(abs(spot), { recursive: true })
			// A fresh look: `mkdir` says nothing about what it made, and succeeds on a
			// directory that was already there.
			return seenAt(spot)
		},

		async stamp(spot, at, was) {
			let before: BigIntStats | null = null
			if (was !== 'unseen') {
				before = await lstat(spot)
				if (before === null || !unchanged(was, before)) return null
			}
			if (!(await stampAt(abs(spot), at))) return null
			const now = await lstat(spot)
			if (now === null) return null
			// Asked again on the other side of the act. A check BEFORE one only ever buys a
			// narrower window: the stamp moves mode, mtime and ctime, so nothing else may
			// have moved. What that still lets through is an edit of exactly the same
			// length, landing inside three syscalls.
			if (
				was !== 'unseen' &&
				before !== null &&
				(String(now.ino) !== was.ino || now.size !== before.size)
			)
				return null
			return { path: spot, ino: String(now.ino), state: stateOf(now) }
		},

		async move(at, to) {
			// Both ends: a rename out of the tree loses the file, and one in from outside
			// adopts something this store was never given.
			if (!(await inside(abs(at.path))) || !(await inside(abs(to)))) return null
			// Kept, so what lands at the far end can be held to what left this one — and the
			// whole observation, not just the inode: an in-place edit keeps the inode, and
			// taking THAT as the baseline hands the writer's bytes on as this move's own.
			const was = await lstat(at.path)
			if (was === null || !unchanged(at, was)) return null
			// The far end too: `rename` replaces whatever is at the name without a word, and
			// both callers have already made the name free. So the one thing that can be there
			// arrived since, nothing has ever seen its bytes, and this is their only copy.
			// Asked immediately before the act, the way `publish` asks: POSIX has no rename
			// that refuses, so two adjacent calls is the whole of what a name can be held to.
			if ((await lstat(to)) !== null) return null
			await rename(abs(at.path), abs(to))
			return held(to, was)
		},

		async drop(at, directory) {
			if (!(await inside(abs(at.path)))) return
			const here = await lstat(at.path)
			if (here === null) return
			// A file to the whole of what was observed, a directory to its identity alone —
			// removing what was inside it is this same batch, and that moved its mtime.
			if (directory ? String(here.ino) !== at.ino : !unchanged(at, here)) return
			if (!directory) {
				await rm(abs(at.path), { force: true })
				return
			}
			// `rmdir` and not a recursive `rm`: it refuses a directory with anything in it, so
			// the check above needs to buy no window here. Anything that arrived since — a
			// local tool's file, a name this store could never address — simply keeps the
			// directory, and the scan makes what is really there a row.
			await rmdir(abs(at.path)).catch(() => {})
		},

		async prune(spot) {
			if (!(await inside(abs(spot)))) return false
			return rmdir(abs(spot)).then(
				() => true,
				() => false
			)
		},

		async clear(spot) {
			if (!(await inside(abs(spot)))) return
			await rm(abs(spot), { recursive: true, force: true })
		},

		async unlock(steps) {
			for (const step of steps) {
				opened.add(step.id)
				const mode = (step.mode & 0o7777) | step.need
				// No `ino` when this store has just made the directory itself; the marking that
				// records its identity comes after.
				if (step.ino === undefined) await modeAt(abs(step.spot), mode)
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

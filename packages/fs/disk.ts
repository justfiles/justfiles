/**
 * The disk, and the only thing that touches it. `store.fs.ts` decides WHAT should
 * be where; this decides how a location is named, whether it is inside the store,
 * and whether the thing at it is still the thing the caller meant.
 *
 * It exists because those three questions used to be asked at seventeen call
 * sites, each remembering for itself — and every one that forgot was a finding.
 * Here they are asked once:
 *
 * - **A location is a `Spot`, and only this module makes one.** A `Spot` is the
 *   relative path of something inside the root, and the only ways to get one are
 *   `root`, `under` (one validated name at a time) and `spot` (which re-validates
 *   text that came back from the sidecar). A name that is not a name — empty,
 *   `.`, `..`, a separator on ANY platform, a NUL — makes no `Spot`, so a row
 *   from a peer, an id used as a path, or a tampered index cannot address
 *   anything outside the tree. The type is the check: there is no second path
 *   into `join`.
 * - **Identity is the inode.** Every call that changes or removes something takes
 *   the `Seen` the caller believes in, and does nothing at all if the disk no
 *   longer holds that inode. A name can change hands between a look and a use,
 *   and this is the one place that window lives.
 * - **A way in is granted and taken back by the same pass.** A directory whose
 *   stated mode shuts this store out is opened for as long as the pass needs it
 *   (`unlock`) and put back as the pass's last act (`relock`). The caller says
 *   WHICH directories are on the way; this owns the opening, the order, and the
 *   state that comes back.
 *
 * A `Spot` is a branded string rather than a pair, so it costs nothing to compare,
 * to key a `Map` with, or to write into the sidecar — and reading one back is the
 * one place it must be checked again, which `spot` is.
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

/** NUL — the one byte a name can never hold. */
const NUL = String.fromCharCode(0)

declare const Inside: unique symbol

/**
 * Somewhere inside the store root, as a path relative to it. `''` is the root
 * itself. Only this module mints one, which is what makes "inside" a fact about
 * the type rather than a check somebody has to remember.
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
 * A name that is not a name: it would resolve somewhere other than one entry, or
 * nowhere at all. Three kinds, and a row from a peer is reason enough to check all
 * of them before its name reaches `join`:
 *
 * - It names a place instead of an entry. `/` always, and `sep` because a platform
 *   may separate on something else too: on Windows `..\victim` resolves clean out of
 *   the store root, and `.jfs\index.json` reaches the index while reading as one
 *   name to the sidecar check. Asking the PLATFORM's separator is what keeps a
 *   backslash a legal filename where it is one.
 * - It names no entry at all: the empty name, `.`, `..`.
 * - `NUL`, the bluntest — the one byte a name cannot hold, which is why every
 *   backend composes keys with it, and `node:fs` refuses a path containing one
 *   outright. A page carrying such a row must not be a page this replica can never
 *   apply.
 */
export const unsafe = (name: string): boolean =>
	name === '' ||
	name === '.' ||
	name === '..' ||
	name.includes('/') ||
	name.includes(sep) ||
	name.includes(NUL)

/**
 * Everything about a file that a write to it changes — and `ctimeNs`, which is the
 * only one no writer can put back. A metadata-preserving sync can restore the mtime
 * over content of the same length, and then mode, mtime and size all still match the
 * file this store recorded while the bytes underneath are somebody else's. The ctime
 * moves on any change to the inode and userland cannot set it, so it is what makes
 * "unchanged" mean unchanged. A look it wakes costs one hash of one file.
 */
export const stateOf = (s: BigIntStats): string => `${s.mode}:${s.mtimeNs}:${s.size}:${s.ctimeNs}`

/** Is this still the file the row was observed at, in the state it was in? */
export const unchanged = (was: Seen, s: BigIntStats): boolean =>
	was.ino === String(s.ino) && was.state === stateOf(s)

/**
 * What a row states about its object, on the object: the two fields POSIX keeps for
 * it. `lutimes`, so a symlink gets its own stamp rather than its target's, and
 * milliseconds, because that is what a `Date` carries — the same trade
 * `storage.fs.ts` already makes for the same field.
 */
export type Stamp = {
	mode: number
	/** Left out to set the mode alone — a directory's stamp waits for its entries. */
	mtimeNs?: bigint
	symlink?: boolean
}

/** The root: the one spot that needs no name to reach. */
export const AT_ROOT = '' as Spot

/**
 * One name deeper, or null when the name is not a name. Shared by every `Disk`,
 * because two implementations that disagreed about what a location IS would make
 * a test against one prove nothing about the other.
 */
export const under = (parent: Spot, name: string): Spot | null =>
	unsafe(name) ? null : ((parent === AT_ROOT ? name : `${parent}/${name}`) as Spot)

/** One name shallower. Root is its own parent, and the walk stops there. */
export const up = (at: Spot): Spot => {
	const cut = at.lastIndexOf('/')
	return (cut === -1 ? '' : at.slice(0, cut)) as Spot
}

/**
 * Text that claims to be a spot — from the sidecar, which is a file anybody can
 * edit. Re-validated name by name, because a `Spot` that was only ever a string
 * on disk has had no check applied to it at all.
 */
export const spot = (text: string): Spot | null => {
	if (text === '') return AT_ROOT
	// Name by name, so one bad component anywhere makes the whole thing no spot at
	// all. An index that says `../../etc` describes nothing this store owns.
	for (const name of text.split('/')) if (unsafe(name)) return null
	return text as Spot
}

export interface Disk {
	/** The root of the store: the one `Spot` that needs no name to reach. */
	readonly root: Spot

	/** One name deeper, or null when the name is not a name. The ONLY way down. */
	under(parent: Spot, name: string): Spot | null

	/** One name shallower. Root is its own parent, and the walk stops there. */
	up(spot: Spot): Spot

	/**
	 * Text that claims to be a spot — from the sidecar, which is a file anybody can
	 * edit. Re-validated name by name, because a `Spot` that was only ever a string
	 * on disk has had no check applied to it at all.
	 */
	spot(text: string): Spot | null

	// ── Looking ────────────────────────────────────────────────────────────────
	stat(spot: Spot): Promise<BigIntStats | null>
	/** Is there NOTHING here — as opposed to nothing this store can see? */
	absent(spot: Spot): Promise<boolean>
	list(spot: Spot): Promise<string[] | null>
	/**
	 * A whole file, or null when there is nothing there.
	 *
	 * `strict` decides what "nothing there" is allowed to mean. Lenient — the
	 * default — is for content: unreadable and absent are both "no bytes", and the
	 * next look tries again. Strict is for anything this store REASONS from: null
	 * only for a file that is genuinely not there, every other answer thrown.
	 * "I could not look" taken for "there is nothing here" is how an index nobody
	 * could read becomes a tree with no history.
	 */
	bytes(spot: Spot, strict?: boolean): Promise<Uint8Array | null>
	target(spot: Spot): Promise<string | null>
	/** Does the disk still hold the file this row named? Identity is the inode. */
	mine(at: Seen): Promise<boolean>

	// ── Changing ───────────────────────────────────────────────────────────────
	/** Bytes into a name in ONE operation: built beside it, then renamed over it. */
	write(spot: Spot, data: Uint8Array): Promise<void>
	/** A symlink into a name, the same way. */
	link(spot: Spot, target: string): Promise<void>
	/** This directory and every one above it. */
	dir(spot: Spot): Promise<void>
	/** What a row states about its object, on the object. */
	stamp(spot: Spot, at: Stamp): Promise<void>

	/**
	 * Rename, but only while the disk still holds the caller's inode. Says whether
	 * it moved; a false is the file having become somebody else's, never an error.
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
	 * Remove whatever is here, whatever it is and whoever it belongs to. The one
	 * unchecked removal, and it exists for one caller: a leftover in the holding
	 * area, which is this store's own and which no row can be under.
	 */
	clear(spot: Spot): Promise<void>

	// ── Ways in ────────────────────────────────────────────────────────────────
	/**
	 * Open every directory on the way that does not already grant what the pass
	 * needs — OUTSIDE in, because a mode without search stops a walk where it
	 * stands, and an ancestor has to be open before the `chmod` below it can land.
	 */
	unlock(steps: Step[]): Promise<void>

	/**
	 * The stated mode back on everything this pass opened — INNERMOST first, the
	 * reverse of the way in. Never throws: it runs on the way out of passes that
	 * are themselves leaving by way of an error. Hands back what it observed, so
	 * the caller can record a state its own chmod moved.
	 *
	 * Where each one is NOW, and what it should state, is asked of the caller at
	 * this moment rather than remembered from `unlock`: the pass in between may
	 * have renamed the directory, or changed the mode its row states, and what
	 * goes back has to be the current answer to both. Null drops it — the row is
	 * gone, or nothing knows where it is any more.
	 */
	relock(
		resolve: (id: NodeId) => { spot: Spot; ino: string; mode: number } | null
	): Promise<Relocked[]>

	/** Is anything still held open? */
	readonly held: boolean

	/**
	 * Ask the OS to say where to look. An event is a HINT and nothing more, so the
	 * type is dropped and only the spot is passed on; `lost` means the watcher is
	 * gone or said something it could not name, and the walk carries it alone from
	 * there. Null when this platform, filesystem or watch budget has none — which
	 * is not a failure, only a tree that gets walked instead.
	 */
	watch(onPath: (spot: Spot) => void, onLost: () => void): (() => void) | null

	/** The absolute path of a spot. For an error message, and for nothing else. */
	where(spot: Spot): string
}

export function fsDisk(rootPath: string): Disk {
	const abs = (at: Spot): string => (at === AT_ROOT ? rootPath : join(rootPath, at))

	const lstat = (at: Spot): Promise<BigIntStats | null> =>
		lstatOf(abs(at), { bigint: true }).catch(() => null)

	/**
	 * Take a name in ONE operation: build the payload under a private sibling and
	 * rename it over the target. POSIX has no atomic content write, so a reader
	 * that resolves the name while `write` is still looping reads a prefix of it.
	 * A SIBLING, because `rename` cannot cross a filesystem and a tree can have
	 * another mount underneath it.
	 */
	const publish = async (spot: Spot, build: (tmp: string) => Promise<void>): Promise<void> => {
		const os = abs(spot)
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

	/**
	 * A mode set on the directory this store MEANT, and not on whatever answers to its
	 * name by the time the call lands. Opened, identified and changed through the one
	 * descriptor, so a rename arriving in between moves the name and not what this acts
	 * on.
	 *
	 * Only where the mode still allows opening it: POSIX wants read permission on a
	 * directory to open it, which `0300`, `0100` and `0000` do not give even to their
	 * owner (measured), and there is no `fchmodat` to ask with here. Those fall back to
	 * the name — identity checked first, and raced at worst.
	 */
	const setMode = async (spot: Spot, ino: string, mode: number): Promise<BigIntStats | null> => {
		const handle = await openPath(abs(spot)).catch(() => null)
		if (handle === null) {
			const s = await lstat(spot)
			if (s === null || String(s.ino) !== ino) return null
			await chmod(abs(spot), mode)
			// The name is all this fallback has, so it asks again rather than assume: at
			// worst it reports nothing, and never somebody else's inode.
			const now = await lstat(spot)
			return now !== null && String(now.ino) === ino ? now : null
		}
		try {
			const s = await handle.stat({ bigint: true })
			if (String(s.ino) !== ino) return null
			await handle.chmod(mode)
			// Taken through the same descriptor, so what comes back is the state of the
			// inode this changed — not of whatever holds the name by now.
			return await handle.stat({ bigint: true })
		} finally {
			await handle.close()
		}
	}

	/** Directories opened for a pass, closed again by the pass that opened them. */
	const opened = new Set<NodeId>()

	const mine = async (at: Seen): Promise<boolean> => {
		const s = await lstat(at.path)
		return s !== null && String(s.ino) === at.ino
	}

	return {
		root: AT_ROOT,
		under,
		up,
		spot,

		stat: lstat,

		async absent(spot) {
			// Only "no such entry" is gone. Anything else the OS says is this store not
			// knowing: no search bit on the way, a device that stopped answering. A row is
			// never buried on not knowing, because a tombstone for a file that is still
			// there loses it for every replica, and the walk that would find it again
			// cannot look either.
			const gone = await lstatOf(abs(spot)).then(
				() => null,
				(e: NodeJS.ErrnoException) => e.code
			)
			return gone === 'ENOENT' || gone === 'ENOTDIR'
		},

		list: (spot) => readdir(abs(spot)).catch(() => null),

		bytes: (spot, strict) =>
			readFile(abs(spot))
				// Not the `Buffer` node hands back: the seam says `Uint8Array`, and a caller
				// that compares what it read against what it wrote must find the same thing.
				.then((b) => new Uint8Array(b))
				.catch((e: NodeJS.ErrnoException) => {
					if (strict && e.code !== 'ENOENT') throw e
					return null
				}),

		target: (spot) => readlink(abs(spot)).catch(() => null),

		mine,

		write: (spot, data) => publish(spot, (tmp) => writeFile(tmp, data)),

		link: (spot, target) => publish(spot, (tmp) => symlink(target, tmp)),

		async dir(spot) {
			await mkdir(abs(spot), { recursive: true })
		},

		async stamp(spot, at) {
			// A symlink's own mode is not settable on every platform, and nothing reads it.
			if (!at.symlink) await chmod(abs(spot), at.mode & 0o7777)
			if (at.mtimeNs === undefined) return
			const when = new Date(Number(at.mtimeNs / 1_000_000n))
			await lutimes(abs(spot), when, when)
		},

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
			// Looking and then removing are two calls, and a name can change hands between
			// them: a recursive `rm` aimed at what arrived in that moment would take a
			// subtree this store never had, which is the one mistake it cannot take back.
			// So it is renamed to a name nobody else knows — one call, whatever holds the
			// name at that instant — and identified there, where nothing can be swapped
			// under it. If it turns out not to be the row's, it goes back where it came
			// from: a thing moved is a thing still there.
			const aside = under(holding, `going-${crypto.randomUUID()}`)
			if (aside === null) return
			await mkdir(abs(holding), { recursive: true })
			const moved = await rename(abs(at.path), abs(aside)).then(
				() => true,
				() => false
			)
			// A rename that cannot happen — another filesystem mounted under this tree — is
			// left with the checked removal, which is what this was before.
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
				// No `ino` from the observation pass: that directory is one this store has
				// just put there itself, and the marking that would record its identity
				// comes after.
				if (step.ino === undefined) await chmod(abs(step.spot), mode)
				else await setMode(step.spot, step.ino, mode)
			}
		},

		async relock(resolve) {
			const out: Relocked[] = []
			for (const id of [...opened].reverse()) {
				const was = resolve(id)
				if (was === null) continue
				// One at a time, and never throwing: this runs on the way out of a pass that
				// may itself be leaving by way of an error, and the error a caller has to see
				// is that one. A directory that cannot be closed — removed, or shut by
				// somebody else — is the world having moved, which the next look reconciles.
				try {
					// The same inode this pass opened, or nothing at all: another process may
					// have renamed it away and left a different directory at the name, and
					// restricting THAT one would be this store changing something it never
					// touched. What was moved keeps the mode it was granted until a walk finds
					// it and states what it finds — the grant recorded, rather than hidden.
					const s = await setMode(was.spot, was.ino, was.mode & 0o7777)
					if (s !== null) out.push({ id, ino: was.ino, state: stateOf(s) })
				} catch {}
			}
			opened.clear()
			return out
		},

		get held() {
			return opened.size > 0
		},

		watch(onPath, onLost) {
			try {
				// `persistent: false` on purpose: a CLI that never closes the store still
				// exits, because a watcher nothing is waiting on does not hold the loop
				// open. It keeps delivering while the process has other work.
				const held = watchPath(rootPath, { recursive: true, persistent: false }, (_type, name) => {
					if (name === null) {
						onLost()
						return
					}
					// The OS spells a path in the platform's separator, and a name it names
					// may be one this store would never make. Through the checked constructor
					// like everything else: an event nobody can address is an event to drop.
					const at = spot(String(name).split(sep).join('/'))
					if (at !== null) onPath(at)
				})
				held.on('error', onLost)
				return () => held.close()
			} catch {
				// No watcher on this platform, this filesystem, or past this many watches
				// (Linux counts them per directory). The tree gets walked instead.
				return null
			}
		},

		where: abs
	}
}

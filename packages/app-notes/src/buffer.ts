/**
 * The editor's buffer, as a machine instead of a discipline.
 *
 * The text being edited, whether it is saved, and where it belongs are one fact with
 * one set of rules — and every rule was learned the same painful way (DESIGN.md §1a‴):
 *
 *   1. Nothing may replace the buffer until it is SETTLED. `settle()` answers that,
 *      and its answer is a value a caller has to look at.
 *   2. A write that did not land leaves the buffer unsaved. Always.
 *   3. A failure is not a diagnosis: "the note is gone" and "the volume is busy" call
 *      for opposite recoveries (detach vs. keep the path so the retry updates it).
 *   4. Writes never overlap, and keystrokes typed DURING a write are not lost — the
 *      buffer settles again rather than reporting a stale success.
 *   5. A read that resolves after the buffer moved on is discarded, never applied.
 *
 * Held in one place so those are properties of the type rather than habits at eight
 * call sites. No React and no volume in here: IO arrives as four functions, so the
 * whole machine is exercised by `buffer.test.ts` with no browser and no filesystem.
 */

import { isUnder } from './notes.ts'

export type BufferState = {
	readonly text: string
	readonly dirty: boolean
	/** Where these bytes belong on disk. `null` = a scratch note that has no home yet. */
	readonly path: string | null
}

/** Why a buffer could not be settled — and therefore what to do about it. */
export type SettleOutcome =
	| { settled: true }
	// The note is gone (moved, deleted, or the path is a folder now). The buffer has
	// detached: its text is still here and will be written as a NEW note.
	| { settled: false; because: 'gone'; path: string; error: Error }
	// The note is still there; the write failed for its own reasons. The buffer stays
	// attached so a retry UPDATES it instead of creating a numbered duplicate.
	| { settled: false; because: 'failed'; path: string | null; error: Error }

/** A settle that did not land — the shape a caller has to explain to the user. */
export type Unsettled = Extract<SettleOutcome, { settled: false }>

export type OpenOutcome =
	| { opened: true }
	// The buffer would not settle, so nothing was replaced. Carries the reason, since
	// the caller is the one showing it.
	| { opened: false; because: 'unsettled'; outcome: Unsettled }
	// Settled, but the note could not be read: it is not there, or not a note at all
	// (a folder called `Archive.md`). The buffer points at nothing now.
	| { opened: false; because: 'unreadable'; path: string; error: Error }

export type BufferIO = {
	/** Overwrite an existing note. Rejects if it is gone (ENOENT) or a folder (EISDIR). */
	save(path: string, text: string): Promise<void>
	/** Create a note from this text; resolves with the path it actually landed at. */
	create(text: string): Promise<string>
	/** Read a note's body. Rejects for anything that is not a readable note. */
	read(path: string): Promise<string>
}

// A note that no longer exists cannot be saved to, ever; anything else can be retried.
const gone = (error: Error) => /ENOENT|EISDIR/.test(error.message)
const asError = (value: unknown) => (value instanceof Error ? value : new Error(String(value)))

export function createBuffer(io: BufferIO, onChange: (state: BufferState) => void) {
	let state: BufferState = { text: '', dirty: false, path: null }
	// Every async entry point runs on this chain. Overlap is where the subtle bugs live:
	// a caller that flushed while a debounced write was in flight used to read the
	// optimistically-cleared `dirty`, conclude "settled", and replace the buffer over
	// words that were still being written — and about to fail.
	let tail: Promise<unknown> = Promise.resolve()
	// Bumped whenever the buffer's identity changes, so a read in flight can tell that
	// it is answering a question nobody is asking any more.
	let generation = 0
	// What an in-flight read is for. The buffer does not point at it YET, which is
	// exactly why it has to be remembered: a note deleted or moved while its body is on
	// the way must not be adopted when the read lands.
	let pending: string | null = null

	const set = (next: Partial<BufferState>) => {
		state = { ...state, ...next }
		onChange(state)
	}

	const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
		const run = tail.then(task, task)
		tail = run.catch(() => {})
		return run
	}

	// One write of the current text. `dirty` is cleared before the await so the caller's
	// debounce does not re-fire for bytes already on their way; if the write fails it
	// goes straight back, because the bytes are not on disk.
	const writeOnce = async (): Promise<SettleOutcome> => {
		const { text, path } = state
		if (path !== null) {
			set({ dirty: false })
			try {
				await io.save(path, text)
				return { settled: true }
			} catch (thrown) {
				const error = asError(thrown)
				set({ dirty: true })
				if (gone(error)) {
					generation++
					set({ path: null })
					return { settled: false, because: 'gone', path, error }
				}
				return { settled: false, because: 'failed', path, error }
			}
		}
		// A blank scratch is not a note. It is settled by definition: there is nothing to
		// lose, and writing it would litter the knowledge base with empty files.
		if (text.trim() === '') {
			set({ dirty: false })
			return { settled: true }
		}
		set({ dirty: false })
		try {
			const created = await io.create(text)
			generation++
			set({ path: created })
			return { settled: true }
		} catch (thrown) {
			const error = asError(thrown)
			set({ dirty: true })
			return { settled: false, because: 'failed', path: null, error }
		}
	}

	const settleNow = async (): Promise<SettleOutcome> => {
		// Loops: text typed while a write was in flight is dirty again by the time it
		// resolves, and reporting "settled" then would let the caller drop those
		// keystrokes. Terminates as soon as the user stops typing.
		for (;;) {
			if (!state.dirty) return { settled: true }
			const outcome = await writeOnce()
			if (!outcome.settled) return outcome
		}
	}

	const openNow = async (path: string): Promise<OpenOutcome> => {
		const settled = await settleNow()
		if (!settled.settled) return { opened: false, because: 'unsettled', outcome: settled }
		const mine = ++generation
		pending = path
		try {
			const text = await io.read(path)
			if (mine !== generation) return { opened: true } // superseded; not ours to apply
			set({ text, dirty: false, path })
			return { opened: true }
		} catch (thrown) {
			const error = asError(thrown)
			if (mine !== generation) return { opened: true }
			// We cannot read it, so we do not stay pointed at it. A dirty buffer keeps its
			// text — typed while the read was in flight, so it is the user's and becomes a
			// scratch note; a clean one held the previous note's body, which would be a lie
			// about what is open.
			set({ path: null, ...(state.dirty ? {} : { text: '' }) })
			return { opened: false, because: 'unreadable', path, error }
		} finally {
			if (pending === path) pending = null
		}
	}

	// Does the buffer hold, or is it about to hold, something under `path`?
	const involves = (path: string) =>
		(state.path !== null && isUnder(state.path, path)) ||
		(pending !== null && isUnder(pending, path))

	return {
		snapshot: (): BufferState => state,

		/** The user typed. The only entry point that makes a buffer dirty. */
		type(text: string) {
			set({ text, dirty: true })
		},

		/** Land the buffer. Check the answer before replacing anything. */
		settle: (): Promise<SettleOutcome> => enqueue(settleNow),

		/** Settle, then show `path`. Refuses (and changes nothing) if it cannot settle. */
		open: (path: string): Promise<OpenOutcome> => enqueue(() => openNow(path)),

		/** Settle, then become an empty scratch buffer. */
		clear: (): Promise<SettleOutcome> =>
			enqueue(async () => {
				const outcome = await settleNow()
				if (!outcome.settled) return outcome
				generation++
				set({ text: '', dirty: false, path: null })
				return outcome
			}),

		/**
		 * The open note changed on disk (an agent or Files edit). Re-read only when the
		 * buffer is clean: a dirty buffer is newer than anything on disk, and replacing it
		 * would throw away what the user is typing.
		 */
		reload: (path: string): Promise<OpenOutcome> =>
			enqueue(async () => {
				if (state.path !== path || state.dirty) return { opened: true }
				return openNow(path)
			}),

		/**
		 * Whatever we hold now lives at `to` (its own move, or a folder's). No IO: the
		 * bytes did not change, only their address — and the buffer must follow, or the
		 * next save writes to a path that no longer exists.
		 */
		moved(from: string, to: string) {
			if (!involves(from)) return
			// A read in flight is for the old address, so it is no longer ours to apply.
			generation++
			pending = null
			if (state.path !== null && isUnder(state.path, from)) {
				set({ path: `${to}${state.path.slice(from.length)}` })
			}
		},

		/**
		 * `path` (or a folder containing it) is being deleted, so the buffer is DISCARDED
		 * rather than settled — a pending write would put the note straight back.
		 */
		discard(path: string) {
			if (!involves(path)) return
			// Covers a read in flight too: a note deleted while its body is on the way must
			// not be adopted when it lands, or the editor shows a note that no longer exists
			// and the next keystroke tries to save it back.
			generation++
			pending = null
			set({ text: '', dirty: false, path: null })
		}
	}
}

export type Buffer = ReturnType<typeof createBuffer>

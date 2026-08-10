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
 *   6. A write never replaces a body the buffer has not seen. It knows what it read, so a
 *      note that changed underneath is either merged (the change was only an append) or
 *      handed to the user as a question — never silently overwritten.
 *
 * Held in one place so those are properties of the type rather than habits at eight
 * call sites. No React and no volume in here: IO arrives as four functions, so the
 * whole machine is exercised by `buffer.test.ts` with no browser and no filesystem.
 */

import { failedWith, isUnder, mergeAppend } from './notes.ts'

export type BufferState = {
	readonly text: string
	readonly dirty: boolean
	/** Where these bytes belong on disk. `null` = a scratch note that has no home yet. */
	readonly path: string | null
	/**
	 * The note changed on disk under these unsaved words, in a way that cannot be merged. The
	 * buffer keeps them and writes NOTHING more until the question is answered — `overwrite()`
	 * to keep them, `revert()` to take the file. Public because only the caller can ask.
	 */
	readonly conflict: boolean
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
	// The note is still there and the write is still possible — it was REFUSED, because the
	// body is no longer the one these words were typed over. Not an error: two people kept
	// different words in one note, and only one of them can be asked which survives. The
	// buffer stays attached and dirty, and stops writing until `overwrite()`/`revert()`.
	| { settled: false; because: 'stale'; path: string }

/** A settle that did not land — the shape a caller has to explain to the user. */
export type Unsettled = Extract<SettleOutcome, { settled: false }>

export type OpenOutcome =
	| { opened: true }
	// The buffer would not settle, so nothing was replaced. Carries the reason, since
	// the caller is the one showing it.
	| { opened: false; because: 'unsettled'; outcome: Unsettled }
	// Settled, but the note could not be read. `gone` separates the two answers that
	// matter: it is not there (or is a folder called `Archive.md`), so the buffer has let
	// go of it — versus a read that merely failed, which changes nothing at all, because
	// an EIO must not turn an attached buffer into a duplicate-in-waiting.
	| { opened: false; because: 'unreadable'; path: string; error: Error; gone: boolean }

export type BufferIO = {
	/**
	 * Overwrite an existing note, but only over `base` — the body the buffer last agreed with
	 * disk about (`null` = write regardless, which is what the scratch and an answered conflict
	 * want). Resolves `{ wrote: false, disk }` when the note holds something else now, carrying
	 * those bytes: the buffer cannot decide anything without them, and reading them again here
	 * would be a second guess at a moving target. Rejects if the note is gone (ENOENT) or is a
	 * folder (EISDIR).
	 */
	save(
		path: string,
		text: string,
		base: string | null
	): Promise<{ wrote: true } | { wrote: false; disk: string }>
	/**
	 * Create a note holding this text, under whatever name the caller has for it — the
	 * buffer has none, because a note is named before it exists (DESIGN.md §4). Resolves
	 * with the path it actually landed at. Reached in ONE case: the note the buffer held
	 * was deleted or moved out from under it, and the words typed since have nowhere else
	 * to go.
	 */
	create(text: string): Promise<string>
	/** Read a note's body. Rejects for anything that is not a readable note. */
	read(path: string): Promise<string>
}

// A note that no longer exists cannot be saved to, ever; anything else can be retried.
const gone = (error: Error) => failedWith(error, 'ENOENT', 'EISDIR')
const asError = (value: unknown) => (value instanceof Error ? value : new Error(String(value)))

export function createBuffer(io: BufferIO, onChange: (state: BufferState) => void) {
	let state: BufferState = { text: '', dirty: false, path: null, conflict: false }
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
	// The last body this buffer and the disk agreed on — set by a read that landed, and by a
	// write that landed (those bytes ARE the file now). It is what every write is conditional
	// on, so the machine can tell "the user typed over this" from "someone else changed it".
	// `null` means no claim: nothing has been read yet, or the user has answered a conflict by
	// choosing their own words, and the next write goes in regardless.
	let base: string | null = null

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
	// `null` means "the buffer moved while these bytes were in flight — go round again":
	// the failure is about an address the buffer no longer has, so it diagnoses nothing.
	const writeOnce = async (): Promise<SettleOutcome | null> => {
		const { text, path } = state
		const mine = generation
		const over = base
		if (path !== null) {
			set({ dirty: false })
			try {
				const wrote = await io.save(path, text, over)
				if (wrote.wrote) {
					base = text
					return { settled: true }
				}
				// Refused: the note holds something these words were never typed over. They are
				// unwritten, so they are dirty again — rule 2, and the same as any other write that
				// did not land.
				set({ dirty: true })
				// The buffer moved while the write was out (an agent rename): the refusal is about
				// an address it no longer has, so it diagnoses nothing. Go round.
				if (generation !== mine) return null
				const merged = over === null ? null : mergeAppend(over, text, wrote.disk)
				if (merged !== null) {
					// Only added to the end — the journal case (DESIGN.md §6). Both sets of words are
					// kept, in the order they were written, and the loop in `settleNow` writes the
					// result. `base` moves to what was on disk, so the retry is conditional on THAT
					// and a second append cannot be lost either.
					base = wrote.disk
					set({ text: merged })
					return null
				}
				// Two real versions of one note. Nobody in this process may pick, so the buffer stops
				// writing and says so — see `conflict`.
				set({ conflict: true })
				return { settled: false, because: 'stale', path }
			} catch (thrown) {
				const error = asError(thrown)
				set({ dirty: true })
				// An agent rename can move the open note while an autosave to its old address is
				// on its way. That save then fails ENOENT about a path nobody is at any more, and
				// treating it as "the note is gone" would detach the buffer FROM ITS NEW ADDRESS
				// and turn the unsaved words into a duplicate. The words simply get written where
				// the note lives now.
				if (generation !== mine) return null
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
			base = text
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
			// An unanswered conflict is not retried. The refusal would only be repeated — once per
			// keystroke, since the words are dirty — and every retry would read the note again.
			if (state.conflict && state.path !== null)
				return { settled: false, because: 'stale', path: state.path }
			const outcome = await writeOnce()
			if (outcome === null) continue // the buffer moved; write to where it is now
			if (!outcome.settled) return outcome
		}
	}

	// ONE read, applied only if the buffer is still asking for it — and it REPLACES what is
	// there, so every caller has to have earned that first (settled, or told to discard).
	// `null` = superseded by the user typing while the body was on its way; only the caller
	// knows whether those words are to be saved and the read retried, or left alone.
	const readNow = async (path: string): Promise<OpenOutcome | null> => {
		const mine = ++generation
		pending = path
		try {
			const text = await io.read(path)
			if (mine !== generation) return state.dirty ? null : { opened: true }
			base = text
			set({ text, dirty: false, path, conflict: false })
			return { opened: true }
		} catch (thrown) {
			const error = asError(thrown)
			if (mine !== generation) return state.dirty ? null : { opened: true }
			const missing = gone(error)
			// Only "it is not there" is grounds for letting go: a transient failure leaves
			// the buffer exactly as it was, so a retry updates the note instead of creating
			// a duplicate beside it. When it IS gone, a dirty buffer keeps its text (typed
			// while the read was in flight, so it is the user's) and a clean one is emptied
			// rather than showing the previous note as though it were this one.
			if (missing) {
				base = null
				// A conflict is a question about a note that exists. This one does not, and the
				// words are about to become a new one, so there is nothing left to answer.
				set({ path: null, conflict: false, ...(state.dirty ? {} : { text: '' }) })
			}
			return { opened: false, because: 'unreadable', path, error, gone: missing }
		} finally {
			if (pending === path) pending = null
		}
	}

	const openNow = async (path: string): Promise<OpenOutcome> => {
		// Loops for the same reason `settleNow` does: the user may type while the body is on
		// its way, and those keystrokes belong to the note they were typed into. So the
		// buffer settles them (to the OLD path) and then reads again — nothing is dropped,
		// and the requested note still ends up open.
		for (;;) {
			const settled = await settleNow()
			if (!settled.settled) return { opened: false, because: 'unsettled', outcome: settled }
			const outcome = await readNow(path)
			if (outcome !== null) return outcome
		}
	}

	// Does the buffer hold, or is it about to hold, something under `path`?
	const involves = (path: string) =>
		(state.path !== null && isUnder(state.path, path)) ||
		(pending !== null && isUnder(pending, path))

	return {
		snapshot: (): BufferState => state,

		/**
		 * The user typed. The only entry point that makes a buffer dirty — and it TAKES
		 * OVER the buffer: a read still in flight would otherwise land on top of these
		 * keystrokes and mark the result clean, which is the user watching their words
		 * vanish. `open` notices and comes round again (see `openNow`).
		 */
		type(text: string) {
			generation++
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
				base = null
				set({ text: '', dirty: false, path: null, conflict: false })
				return outcome
			}),

		/**
		 * The user answered a conflict: THESE words, over whatever is there now. The next write
		 * carries no base, so it cannot be refused a second time — that is the whole content of
		 * the answer, and asking again would be pretending they had not given it.
		 */
		overwrite: (): Promise<SettleOutcome> =>
			enqueue(async () => {
				// Dropping the base is what "over whatever is there" means, so it happens only where
				// that was actually answered. Otherwise this is an ordinary settle — a caller must
				// not be able to turn an unconditional write on by calling the wrong method.
				if (state.conflict) {
					base = null
					set({ conflict: false, dirty: true })
				}
				return settleNow()
			}),

		/**
		 * The other answer: the file, not these words. Reads first and replaces only if that
		 * lands — a revert whose read failed would have cost the user their edits AND left them
		 * with nothing to show for it.
		 *
		 * The user typing through the read outranks the answer they gave before it, so the read
		 * is discarded (`readNow` returns `null`) and the conflict stands.
		 */
		revert: (): Promise<OpenOutcome> =>
			enqueue(async () => {
				const path = state.path
				// Only ever an ANSWER, never a way to throw edits away: `readNow` replaces what is
				// on screen, so the one caller that may reach it is the one holding the question.
				if (path === null || !state.conflict) return { opened: true }
				return (await readNow(path)) ?? { opened: true }
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
		 *
		 * Returns THE WAY BACK, because the discard happens before the delete is known to
		 * have worked: a delete that fails must cost the user neither the note nor the
		 * unsaved edits. `null` when the buffer was holding something else, and the way back
		 * declines if anything happened to the buffer meanwhile — words typed after the
		 * discard are the user's newest and outrank a snapshot taken before them.
		 */
		discard(path: string): (() => void) | null {
			if (!involves(path)) return null
			const previous = { ...state }
			// The base goes back with the words: those bytes are what the restored text was
			// typed over, and a way back that dropped it would make the first write after a
			// failed delete unconditional again.
			const wasOver = base
			// Covers a read in flight too: a note deleted while its body is on the way must
			// not be adopted when it lands, or the editor shows a note that no longer exists
			// and the next keystroke tries to save it back.
			generation++
			pending = null
			base = null
			set({ text: '', dirty: false, path: null, conflict: false })
			const undiscarded = generation
			return () => {
				if (generation !== undiscarded) return
				generation++
				base = wasOver
				set(previous)
			}
		}
	}
}

export type Buffer = ReturnType<typeof createBuffer>

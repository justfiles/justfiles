import { newDoc, type Op, type PaintDoc } from './doc.ts'
import { createStore, type Effect, type Store } from './state.ts'

// GUI-local working state: the committed op-log (`doc`) plus the in-memory redo
// tail. The canvas is `replay(doc)`; the redo tail never persists.
export type PaintStoreState = { doc: PaintDoc; redo: Op[] }

export type PaintAction =
	| { type: 'loaded'; doc: PaintDoc } // hydrate from the autosaved draft
	| { type: 'commit'; op: Op } // append a committed op (truncates redo)
	| { type: 'undo' }
	| { type: 'redo' }

function reducer(s: PaintStoreState, a: PaintAction): PaintStoreState {
	switch (a.type) {
		case 'loaded':
			return { doc: a.doc, redo: [] }
		case 'commit':
			return { doc: { ...s.doc, ops: [...s.doc.ops, a.op] }, redo: [] }
		case 'undo': {
			const last = s.doc.ops.at(-1)
			if (!last) return s
			return { doc: { ...s.doc, ops: s.doc.ops.slice(0, -1) }, redo: [...s.redo, last] }
		}
		case 'redo': {
			const op = s.redo.at(-1)
			if (!op) return s
			return { doc: { ...s.doc, ops: [...s.doc.ops, op] }, redo: s.redo.slice(0, -1) }
		}
	}
}

const DEBOUNCE_MS = 300
const MAX_WAIT_MS = 2000

export interface PersistController {
	effect: Effect<PaintStoreState, PaintAction>
	flush(): void // force any pending write out now (unmount / page hide)
}

// Trailing-edge debounce (~300ms, maxWait ~2s) with a string-equality guard to
// suppress no-op writes — Frieren's OS persistence pattern. The duplication is
// deliberate: it's the second hand-rolled debounce that justifies extracting a
// shared helper (DESIGN §8 / phase 3).
export function makePersistEffect(save: (doc: PaintDoc) => void): PersistController {
	let lastWritten: string | null = null
	let pending: PaintDoc | null = null
	let timer: ReturnType<typeof setTimeout> | null = null
	let firstAt = 0

	const write = (doc: PaintDoc) => {
		const serialized = JSON.stringify(doc)
		if (serialized === lastWritten) return
		lastWritten = serialized
		save(doc)
	}

	const flush = () => {
		if (timer !== null) {
			clearTimeout(timer)
			timer = null
		}
		firstAt = 0
		const doc = pending
		pending = null
		if (doc) write(doc)
	}

	const effect: Effect<PaintStoreState, PaintAction> = (action, _previous, next) => {
		// The loaded doc is already on disk — record it so the hydration dispatch
		// doesn't round-trip the bytes we just read.
		if (action.type === 'loaded') {
			lastWritten = JSON.stringify(next.doc)
			return
		}
		pending = next.doc
		const now = Date.now()
		if (firstAt === 0) firstAt = now
		if (timer !== null) clearTimeout(timer)
		timer = setTimeout(flush, Math.min(DEBOUNCE_MS, Math.max(0, firstAt + MAX_WAIT_MS - now)))
	}

	return { effect, flush }
}

export function createPaintStore(persist: PersistController): Store<PaintStoreState, PaintAction> {
	return createStore({
		initialState: { doc: newDoc(), redo: [] },
		reducer,
		effects: [persist.effect]
	})
}

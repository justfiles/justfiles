import { describe, expect, it } from 'vitest'
import { newDoc, type Op } from './doc.ts'
import { createPaintStore, makePersistEffect } from './store.ts'

const op: Op = { id: 'stroke-1', kind: 'clear', color: '#ffffff' }

describe('paint store', () => {
	it('undoes, redoes, and flushes the visible document', () => {
		const saved = [] as ReturnType<typeof newDoc>[]
		const persist = makePersistEffect((doc) => saved.push(doc))
		const store = createPaintStore(persist)

		store.dispatch({ type: 'commit', op })
		store.dispatch({ type: 'undo' })
		expect(store.getState()).toEqual({ doc: newDoc(), redo: [op] })

		store.dispatch({ type: 'redo' })
		persist.flush()

		expect(store.getState().doc.ops).toEqual([op])
		expect(saved.at(-1)?.ops).toEqual([op])
	})
})

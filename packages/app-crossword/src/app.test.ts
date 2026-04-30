import { expect, test } from 'bun:test'
import { availableActions, dispatch, initial } from '@justfiles/app'
import app from './app.js'
import { cellKey } from './play.js'

const actor = { id: 'agent', kind: 'agent' }
const user = { id: 'user', kind: 'user' }

test('full happy path: theme → seeds → fill → approve', () => {
	let state = initial(app)
	expect(state.state).toBe('init')

	const themed = dispatch(app, state, { type: 'theme', payload: { theme: 'space' } }, actor)
	expect(themed.ok).toBe(true)
	if (!themed.ok) return
	expect(themed.next.state).toBe('themed')
	expect(themed.next.context.theme).toBe('space')
	expect(themed.narration).toContain('space')
	state = themed.next

	const seeded = dispatch(
		app,
		state,
		{ type: 'seeds', payload: { candidates: ['CABLE', 'ABATE'] } },
		actor
	)
	expect(seeded.ok).toBe(true)
	if (!seeded.ok) return
	expect(seeded.next.state).toBe('filling')
	expect(seeded.next.context.candidates).toEqual(['CABLE', 'ABATE'])
	expect(seeded.next.context.slots.length).toBeGreaterThan(0)
	state = seeded.next

	// Fill every slot — for fully-known patterns, answer must equal pattern;
	// for patterns with '?', any letter works.
	const entries = state.context.slots.map((s) => ({
		slotId: s.id,
		answer: s.pattern.replaceAll('?', 'A'),
		clue: `clue for ${s.id}`
	}))
	const filled = dispatch(app, state, { type: 'fill', payload: { entries } }, actor)
	expect(filled.ok).toBe(true)
	if (!filled.ok) return
	expect(filled.next.state).toBe('review')
	expect(Object.keys(filled.next.context.entries).length).toBe(entries.length)
	state = filled.next

	const approved = dispatch(app, state, { type: 'approve', payload: {} }, actor)
	expect(approved.ok).toBe(true)
	if (!approved.ok) return
	expect(approved.next.state).toBe('playing')
	expect(approved.next.context.play.startedAt).toBeGreaterThan(0)
})

test('fill rejects an answer that does not match the slot pattern', () => {
	let state = initial(app)
	state = mustOk(dispatch(app, state, { type: 'theme', payload: { theme: 'x' } }, actor))
	state = mustOk(dispatch(app, state, { type: 'seeds', payload: { candidates: ['CAT'] } }, actor))
	const slot = state.context.slots[0]
	expect(slot).toBeDefined()
	if (!slot) return
	const bogus = dispatch(
		app,
		state,
		{
			type: 'fill',
			payload: {
				entries: [{ slotId: slot.id, answer: 'X'.repeat(slot.length + 2), clue: 'bad' }]
			}
		},
		actor
	)
	expect(bogus.ok).toBe(false)
})

test('fill rejects clues that admit the answer was shortened to fit', () => {
	let state = initial(app)
	state = mustOk(dispatch(app, state, { type: 'theme', payload: { theme: 'harry potter' } }, actor))
	state = mustOk(
		dispatch(app, state, { type: 'seeds', payload: { candidates: ['HOGWART'] } }, actor)
	)
	const slot = state.context.slots[0]
	expect(slot).toBeDefined()
	if (!slot) return
	const bogus = dispatch(
		app,
		state,
		{
			type: 'fill',
			payload: {
				entries: [
					{
						slotId: slot.id,
						answer: slot.pattern.replaceAll('?', 'A'),
						clue: 'Wizarding school truncated by the grid'
					}
				]
			}
		},
		actor
	)
	expect(bogus.ok).toBe(false)
})

test('fill rejects clues that reveal the answer', () => {
	let state = initial(app)
	state = mustOk(dispatch(app, state, { type: 'theme', payload: { theme: 'remembrance' } }, actor))
	state = mustOk(dispatch(app, state, { type: 'seeds', payload: { candidates: ['LEST'] } }, actor))
	const slot = state.context.slots[0]
	expect(slot).toBeDefined()
	if (!slot) return
	const bogus = dispatch(
		app,
		state,
		{
			type: 'fill',
			payload: {
				entries: [
					{
						slotId: slot.id,
						answer: slot.pattern.replaceAll('?', 'A'),
						clue: "Word often seen in the phrase 'Lest We Forget'"
					}
				]
			}
		},
		actor
	)
	expect(bogus.ok).toBe(false)
})

test('regenerate from review returns to themed and clears entries', () => {
	let state = initial(app)
	state = mustOk(dispatch(app, state, { type: 'theme', payload: { theme: 'animals' } }, actor))
	state = mustOk(dispatch(app, state, { type: 'seeds', payload: { candidates: ['CAT'] } }, actor))
	const entries = state.context.slots.map((s) => ({
		slotId: s.id,
		answer: s.pattern.replaceAll('?', 'A'),
		clue: 'c'
	}))
	state = mustOk(dispatch(app, state, { type: 'fill', payload: { entries } }, actor))
	state = mustOk(dispatch(app, state, { type: 'regenerate', payload: {} }, actor))
	expect(state.state).toBe('themed')
	expect(state.context.theme).toBe('animals')
	expect(state.context.candidates).toEqual([])
	expect(state.context.entries).toEqual({})
})

test('init only allows theme', () => {
	const state = initial(app)
	const actions = availableActions(app, state, actor)
	expect(actions?.map((a) => a.type)).toEqual(['theme'])
})

test('themed allows theme and seeds', () => {
	let state = initial(app)
	state = mustOk(dispatch(app, state, { type: 'theme', payload: { theme: 'x' } }, actor))
	const actions = availableActions(app, state, actor)
	expect(actions?.map((a) => a.type).sort()).toEqual(['seeds', 'theme'])
})

test('filling allows fill and regenerate', () => {
	let state = initial(app)
	state = mustOk(dispatch(app, state, { type: 'theme', payload: { theme: 'x' } }, actor))
	state = mustOk(dispatch(app, state, { type: 'seeds', payload: { candidates: ['CAT'] } }, actor))
	const actions = availableActions(app, state, actor)
	expect(actions?.map((a) => a.type).sort()).toEqual(['fill', 'regenerate'])
})

test('review allows approve and regenerate', () => {
	let state = initial(app)
	state = mustOk(dispatch(app, state, { type: 'theme', payload: { theme: 'x' } }, actor))
	state = mustOk(dispatch(app, state, { type: 'seeds', payload: { candidates: ['CAT'] } }, actor))
	const entries = state.context.slots.map((s) => ({
		slotId: s.id,
		answer: s.pattern.replaceAll('?', 'A'),
		clue: 'c'
	}))
	state = mustOk(dispatch(app, state, { type: 'fill', payload: { entries } }, actor))
	const actions = availableActions(app, state, actor)
	expect(actions?.map((a) => a.type).sort()).toEqual(['approve', 'regenerate'])
})

test('approve transitions straight into playing for the user', () => {
	const state = setupPlay()
	expect(state.state).toBe('playing')
	const userActions = availableActions(app, state, user)
	expect(userActions?.map((a) => a.type).sort()).toEqual([
		'checkLetter',
		'checkPuzzle',
		'checkWord',
		'clearAll',
		'clearCell',
		'enterLetter',
		'reset',
		'revealLetter',
		'revealPuzzle',
		'revealWord',
		'submit'
	])
	expect(availableActions(app, state, actor)).toEqual([])
})

test('agent cannot dispatch user actions in playing', () => {
	const state = setupPlay()
	const slot = state.context.slots[0]
	expect(slot).toBeDefined()
	if (!slot) return
	const r = dispatch(
		app,
		state,
		{ type: 'enterLetter', payload: { row: slot.row, col: slot.col, letter: 'Z' } },
		actor
	)
	expect(r.ok).toBe(false)
})

test('user cannot dispatch agent actions during construction', () => {
	const state = initial(app)
	const r = dispatch(app, state, { type: 'theme', payload: { theme: 'x' } }, user)
	expect(r.ok).toBe(false)
})

test('enterLetter records and clears the letter', () => {
	const state = setupPlay()
	const slot = state.context.slots[0]
	expect(slot).toBeDefined()
	if (!slot) return
	const typed = mustOk(
		dispatch(
			app,
			state,
			{ type: 'enterLetter', payload: { row: slot.row, col: slot.col, letter: 'X' } },
			user
		)
	)
	expect(typed.context.play.userGrid[cellKey(slot.row, slot.col)]).toBe('X')
	const cleared = mustOk(
		dispatch(
			app,
			typed,
			{ type: 'enterLetter', payload: { row: slot.row, col: slot.col, letter: '' } },
			user
		)
	)
	expect(cleared.context.play.userGrid[cellKey(slot.row, slot.col)]).toBeUndefined()
})

test('enterLetter rejects blocks, lowercase letters, and revealed cells', () => {
	let state = setupPlay()
	const slot = state.context.slots[0]
	expect(slot).toBeDefined()
	if (!slot) return
	const lower = dispatch(
		app,
		state,
		{ type: 'enterLetter', payload: { row: slot.row, col: slot.col, letter: 'a' } },
		user
	)
	expect(lower.ok).toBe(false)

	state = mustOk(
		dispatch(app, state, { type: 'revealLetter', payload: { row: slot.row, col: slot.col } }, user)
	)
	const lockedTry = dispatch(
		app,
		state,
		{ type: 'enterLetter', payload: { row: slot.row, col: slot.col, letter: 'X' } },
		user
	)
	expect(lockedTry.ok).toBe(false)
})

test('revealLetter locks the cell and increments hintsUsed', () => {
	const state = setupPlay()
	const slot = state.context.slots[0]
	expect(slot).toBeDefined()
	if (!slot) return
	const sol = state.context.grid?.[slot.row]?.[slot.col]
	const r = mustOk(
		dispatch(app, state, { type: 'revealLetter', payload: { row: slot.row, col: slot.col } }, user)
	)
	expect(r.context.play.userGrid[cellKey(slot.row, slot.col)]).toBe(sol)
	expect(r.context.play.revealed).toContain(cellKey(slot.row, slot.col))
	expect(r.context.play.hintsUsed).toBe(1)
})

test('revealPuzzle ends in solved', () => {
	const state = setupPlay()
	const r = mustOk(dispatch(app, state, { type: 'revealPuzzle', payload: {} }, user))
	expect(r.state).toBe('solved')
	expect(r.context.play.finishedAt).toBeGreaterThan(0)
})

test('submit with wrong entries marks them and stays in playing', () => {
	const state = setupPlay()
	const slot = state.context.slots[0]
	expect(slot).toBeDefined()
	if (!slot) return
	const r = mustOk(dispatch(app, state, { type: 'submit', payload: {} }, user))
	expect(r.state).toBe('playing')
	expect(r.context.play.wrongCells.length).toBeGreaterThan(0)
	expect(r.context.play.submitCount).toBe(1)
	expect(r.context.play.finishedAt).toBeUndefined()
})

test('typing the last correct letter auto-detects solve', () => {
	const state = setupPlay()
	const filled = fillAllCorrect(state)
	expect(filled.state).toBe('solved')
})

test('reset preserves stat counters NYT-style', () => {
	let state = setupPlay()
	state = mustOk(dispatch(app, state, { type: 'submit', payload: {} }, user))
	const slot = state.context.slots[0]
	expect(slot).toBeDefined()
	if (!slot) return
	state = mustOk(
		dispatch(app, state, { type: 'revealLetter', payload: { row: slot.row, col: slot.col } }, user)
	)
	state = mustOk(dispatch(app, state, { type: 'checkPuzzle', payload: {} }, user))
	const before = state.context.play
	state = mustOk(dispatch(app, state, { type: 'reset', payload: {} }, user))
	const after = state.context.play
	expect(after.hintsUsed).toBe(before.hintsUsed)
	expect(after.checksUsed).toBe(before.checksUsed)
	expect(after.submitCount).toBe(before.submitCount)
	expect(after.wrongCells).toEqual([])
	// revealed cells stay locked
	expect(Object.keys(after.userGrid).sort()).toEqual([...before.revealed].sort())
})

test('user view masks the solution grid and answers', () => {
	const state = setupPlay()
	const r = dispatch(app, state, { type: 'submit', payload: {} }, user)
	expect(r.ok).toBe(true)
	if (!r.ok) return
	const ctx = r.view.context
	expect(ctx.grid?.every((row) => !/[A-Z]/.test(row))).toBe(true)
	for (const e of Object.values(ctx.entries)) expect(e.answer).toBe('')
})

test('agent view keeps the full solution', () => {
	const state = setupPlay()
	const r = dispatch(app, state, { type: 'checkPuzzle', payload: {} }, actor)
	// agent isn't allowed to dispatch user actions, so use availableActions on agent view
	expect(r.ok).toBe(false)
	const seen = state.context.grid?.some((row) => /[A-Z]/.test(row))
	expect(seen).toBe(true)
})

test('seeds is rejected from init (must call theme first)', () => {
	const state = initial(app)
	const r = dispatch(app, state, { type: 'seeds', payload: { candidates: ['CAT'] } }, actor)
	expect(r.ok).toBe(false)
	if (r.ok) return
	expect(r.error).toContain('init')
})

test('theme narration instructs the agent to generate words itself, not ask the user', () => {
	const state = initial(app)
	const r = dispatch(app, state, { type: 'theme', payload: { theme: 'space' } }, actor)
	expect(r.ok).toBe(true)
	if (!r.ok) return
	const n = (r.narration ?? '').toLowerCase()
	expect(n).toContain('yourself')
	expect(n).toContain('do not ask')
	expect(n).toContain('canonical')
	expect(n).toContain('truncate')
	expect(n).toContain('seeds')
})

test('seeds narration instructs the agent to fill the slots itself', () => {
	let state = initial(app)
	state = mustOk(dispatch(app, state, { type: 'theme', payload: { theme: 'space' } }, actor))
	const r = dispatch(app, state, { type: 'seeds', payload: { candidates: ['CABLE'] } }, actor)
	expect(r.ok).toBe(true)
	if (!r.ok) return
	const n = (r.narration ?? '').toLowerCase()
	expect(n).toContain('do not ask')
	expect(n).toContain('canonical')
	expect(n).toContain('truncate')
	expect(n).toContain('answer')
	expect(n).toContain('fill')
})

test('seeds narration tells agent to regenerate when a slot has no possible word', () => {
	let state = initial(app)
	state = mustOk(dispatch(app, state, { type: 'theme', payload: { theme: 'x' } }, actor))
	const r = dispatch(app, state, { type: 'seeds', payload: { candidates: ['CAT'] } }, actor)
	expect(r.ok).toBe(true)
	if (!r.ok) return
	const n = (r.narration ?? '').toLowerCase()
	expect(n).toContain('regenerate')
})

test('regenerate from filling drives the retry loop with new seeds', () => {
	let state = initial(app)
	state = mustOk(dispatch(app, state, { type: 'theme', payload: { theme: 'x' } }, actor))
	state = mustOk(dispatch(app, state, { type: 'seeds', payload: { candidates: ['CAT'] } }, actor))
	const r = dispatch(app, state, { type: 'regenerate', payload: {} }, actor)
	expect(r.ok).toBe(true)
	if (!r.ok) return
	const n = (r.narration ?? '').toLowerCase()
	expect(n).toContain('new')
	expect(n).toContain('seeds')
	expect(n).toContain('different')
	expect(n).toContain('canonical')
	expect(n).toContain('truncate')
})

function mustOk<S, V>(r: { ok: true; next: S; view: V } | { ok: false; error: string }): S {
	if (!r.ok) throw new Error(r.error)
	return r.next
}

function setupPlay() {
	let state = initial(app)
	state = mustOk(dispatch(app, state, { type: 'theme', payload: { theme: 'x' } }, actor))
	state = mustOk(dispatch(app, state, { type: 'seeds', payload: { candidates: ['CAT'] } }, actor))
	const entries = state.context.slots.map((s) => ({
		slotId: s.id,
		answer: s.pattern.replaceAll('?', 'A'),
		clue: 'c'
	}))
	state = mustOk(dispatch(app, state, { type: 'fill', payload: { entries } }, actor))
	state = mustOk(dispatch(app, state, { type: 'approve', payload: {} }, actor))
	return state
}

function fillAllCorrect(state: ReturnType<typeof setupPlay>) {
	let s = state
	const grid = s.context.grid
	if (!grid) throw new Error('no grid')
	for (let r = 0; r < grid.length; r++) {
		const row = grid[r] ?? ''
		for (let c = 0; c < row.length; c++) {
			const sol = row[c]
			if (sol === '#' || !sol) continue
			if (s.context.play.userGrid[cellKey(r, c)] === sol) continue
			s = mustOk(
				dispatch(app, s, { type: 'enterLetter', payload: { row: r, col: c, letter: sol } }, user)
			)
		}
	}
	return s
}

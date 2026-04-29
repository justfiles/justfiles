import { expect, test } from 'bun:test'
import { availableActions, dispatch, initial } from '@justfiles/app'
import app from './app.js'

const actor = { id: 'agent', kind: 'agent' }

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
	expect(approved.next.state).toBe('ready')
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

test('ready allows nothing', () => {
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
	expect(state.state).toBe('ready')
	expect(availableActions(app, state, actor)).toEqual([])
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
})

function mustOk<S, V>(r: { ok: true; next: S; view: V } | { ok: false; error: string }): S {
	if (!r.ok) throw new Error(r.error)
	return r.next
}

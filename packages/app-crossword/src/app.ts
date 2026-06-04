import { defineApp } from '@justfiles/app'
import { ai } from '@justfiles/app/capabilities/ai'
import * as v from 'valibot'
import {
	bakeAnswers,
	buildPuzzle,
	type Cell,
	cellKey,
	patternMatches,
	type Slot
} from './puzzle.ts'

const SIZE = 11

export type Entry = { slotId: string; answer: string; clue: string }
export type Puzzle = {
	theme: string
	grid: string[]
	slots: Slot[]
	entries: Record<string, Entry>
}
export type Phase = 'idle' | 'awaiting-seeds' | 'awaiting-fill' | 'playing' | 'solved'
export type CrosswordState = {
	phase: Phase
	theme: string
	puzzle: Puzzle | null
	userGrid: Record<Cell, string>
	revealed: Cell[]
	wrong: Cell[]
	briefing: string | null
}

export const initialState: CrosswordState = {
	phase: 'idle',
	theme: '',
	puzzle: null,
	userGrid: {},
	revealed: [],
	wrong: [],
	briefing: null
}

const upper = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '')

const parseCell = (key: Cell): [number, number] => {
	const [r, c] = key.split(',').map(Number)
	return [r ?? 0, c ?? 0]
}

const fillBriefing = (slots: Slot[]) =>
	[
		`Step 2: for each of the ${slots.length} slots below, pick a thematic answer matching the pattern (? = any letter) and write a clue. Never include the answer in its clue.`,
		'Slots:',
		slots.map((s) => `  ${s.id} ${s.direction} ${s.pattern}`).join('\n'),
		'Run the fill action with { entries: [{ slotId, answer, clue }, ...] }. If no real word fits a pattern, ask the user to pick a different theme.'
	].join('\n')

type Ai = {
	generateText(input: { system?: string; prompt: string }): Promise<{ text: string }>
}

function solved(state: CrosswordState): CrosswordState {
	const grid = state.puzzle?.grid
	if (!grid || state.phase !== 'playing') return state
	for (let r = 0; r < grid.length; r++) {
		const row = grid[r] ?? ''
		for (let c = 0; c < row.length; c++) {
			if (row[c] === '#') continue
			if (state.userGrid[cellKey(r, c)] !== row[c]) return state
		}
	}
	return { ...state, phase: 'solved' }
}

function playState(theme: string, grid: string[], slots: Slot[], entries: Entry[]): CrosswordState {
	const map: Record<string, Entry> = {}
	for (const entry of entries) map[entry.slotId] = entry
	return {
		...initialState,
		phase: 'playing',
		theme,
		puzzle: { theme, grid: bakeAnswers(grid, slots, entries), slots, entries: map }
	}
}

async function generateSeeds(ai: Ai, theme: string): Promise<string[]> {
	const { text } = await ai.generateText({
		system: 'Return JSON only.',
		prompt: `Theme: ${theme}. Return {"words":[...]} with 8-12 themed single words, uppercase A-Z only, length 3-8.`
	})
	const words = (json(text) as { words?: unknown }).words
	if (!Array.isArray(words)) throw new Error('AI did not return words')
	return words.map((w) => upper(String(w))).filter((w) => w.length >= 3 && w.length <= 8)
}

async function generateEntries(ai: Ai, theme: string, slots: Slot[]): Promise<Entry[]> {
	const { text } = await ai.generateText({
		system: 'Return JSON only. Never include an answer in its clue.',
		prompt: [
			`Theme: ${theme}. Fill every crossword slot.`,
			'Each answer must match its pattern exactly (? = any A-Z letter).',
			'Return {"entries":[{"slotId":"A1","answer":"WORD","clue":"..."}]}.',
			slots.map((s) => `${s.id} ${s.pattern}`).join('\n')
		].join('\n')
	})
	const entries = (json(text) as { entries?: unknown }).entries
	if (!Array.isArray(entries)) throw new Error('AI did not return entries')
	return entries.map((e) => {
		const value = e as { slotId?: unknown; answer?: unknown; clue?: unknown }
		return {
			slotId: String(value.slotId ?? ''),
			answer: upper(String(value.answer ?? '')),
			clue: String(value.clue ?? '')
		}
	})
}

function json(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		const start = text.indexOf('{')
		const end = text.lastIndexOf('}')
		if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1))
		throw new Error('AI returned invalid JSON')
	}
}

function validateEntries(slots: Slot[], entries: Entry[]): Entry[] {
	const slotMap = new Map(slots.map((s) => [s.id, s]))
	return entries.map((entry) => {
		const slot = slotMap.get(entry.slotId)
		if (!slot) throw new Error(`unknown slot ${entry.slotId}`)
		if (!patternMatches(entry.answer, slot.pattern))
			throw new Error(`answer ${entry.answer} does not match ${slot.pattern}`)
		if (!entry.clue || entry.clue.toUpperCase().includes(entry.answer))
			throw new Error(`clue for ${entry.slotId} reveals the answer`)
		return entry
	})
}

const slotSchema = v.object({
	id: v.string(),
	direction: v.picklist(['across', 'down'] as const),
	row: v.number(),
	col: v.number(),
	length: v.number(),
	pattern: v.string()
})
const entrySchema = v.object({ slotId: v.string(), answer: v.string(), clue: v.string() })
// A fully-built puzzle, committed in one transition. The `start` procedure does
// the AI generation off to the side and dispatches this only once everything is
// in hand — so a failed generation never leaves a half-built puzzle in state.
const playSchema = v.object({
	theme: v.string(),
	grid: v.array(v.string()),
	slots: v.array(slotSchema),
	entries: v.array(entrySchema)
})

export const app = defineApp({
	init: initialState,
	capabilities: { ai: ai({ scopes: [] }) },
	update: (t) => ({
		play: t.commit(playSchema, (_state, { theme, grid, slots, entries }) =>
			playState(theme, grid, slots, entries)
		),
		seeds: t.on(
			v.object({ words: v.array(v.string()) }),
			(state, { words }) => {
				if (!state.theme) throw new Error('no theme — run start first')
				const seeds = words.map(upper).filter((w) => w.length >= 2)
				if (seeds.length === 0) throw new Error('words must include at least one usable word')
				const built = buildPuzzle(seeds, SIZE)
				if (built.slots.length === 0) throw new Error('no slots produced — try different seeds')
				const puzzle = { theme: state.theme, grid: built.grid, slots: built.slots, entries: {} }
				return {
					...state,
					phase: 'awaiting-fill' as const,
					puzzle,
					userGrid: {},
					revealed: [],
					wrong: [],
					briefing: fillBriefing(built.slots)
				}
			},
			{
				description:
					'Submit themed seed words. Triggers grid generation and returns slots needing answers.',
				examples: [{ params: { words: ['ORBIT', 'COMET', 'NEBULA', 'APOLLO'] } }]
			}
		),
		fill: t.on(
			v.object({
				entries: v.array(entrySchema)
			}),
			(state, { entries }) => {
				const prev = state.puzzle
				if (!prev) throw new Error('no puzzle to fill — run seeds first')
				const nextEntries = validateEntries(
					prev.slots,
					entries.map((e) => ({ slotId: e.slotId, answer: upper(e.answer), clue: e.clue }))
				)
				return playState(prev.theme, prev.grid, prev.slots, nextEntries)
			},
			{
				description:
					'Provide answer + clue for every slot. Each answer must match its slot pattern.'
			}
		),
		enter: t.on(
			v.object({ row: v.number(), col: v.number(), letter: v.string() }),
			(state, { row, col, letter }) => {
				if (!state.puzzle || state.phase === 'solved') return state
				const key = cellKey(row, col)
				if (state.revealed.includes(key)) return state
				const nextGrid = { ...state.userGrid }
				const value = upper(letter)[0]
				if (value) nextGrid[key] = value
				else delete nextGrid[key]
				return solved({ ...state, userGrid: nextGrid, wrong: state.wrong.filter((k) => k !== key) })
			},
			{ description: 'Enter or clear one user letter in the grid.' }
		),
		reveal: t.on(
			v.object({ cells: v.array(v.string()) }),
			(state, { cells }) => {
				const puzzle = state.puzzle
				if (!puzzle || state.phase === 'solved') return state
				const userGrid = { ...state.userGrid }
				const revealed = new Set(state.revealed)
				for (const cell of cells as Cell[]) {
					const [r, c] = parseCell(cell)
					const answer = puzzle.grid[r]?.[c]
					if (answer && answer !== '#') {
						userGrid[cell] = answer
						revealed.add(cell)
					}
				}
				return solved({ ...state, userGrid, revealed: [...revealed], wrong: [] })
			},
			{ description: 'Reveal solution letters for selected cells.' }
		),
		check: t.on(
			v.object({ cells: v.array(v.string()) }),
			(state, { cells }) => {
				const puzzle = state.puzzle
				if (!puzzle) return state
				const wrong = new Set(state.wrong)
				for (const cell of cells as Cell[]) {
					const [r, c] = parseCell(cell)
					const answer = puzzle.grid[r]?.[c]
					if (!answer || answer === '#') continue
					if (state.userGrid[cell] !== answer) wrong.add(cell)
					else wrong.delete(cell)
				}
				return { ...state, wrong: [...wrong] }
			},
			{ description: 'Mark selected user letters as wrong when they do not match the solution.' }
		)
	}),
	// The AI-driven setup is a multi-step chain (generate seeds → build grid →
	// generate clues), so it lives in a procedure. It computes the whole puzzle
	// before committing it through the pure `play` edge.
	procedures: (p) => ({
		start: p.procedure({
			description: 'Generate and start a new crossword for a theme.',
			schema: v.object({ theme: v.string() }),
			async run({ theme }, app) {
				const t = theme.trim()
				if (!t) throw new Error('theme is required')
				const generate: Ai = { generateText: (input) => app.invoke('ai', 'generateText', input) }
				const seeds = await generateSeeds(generate, t)
				if (seeds.length === 0) throw new Error('AI returned no usable words')
				const built = buildPuzzle(seeds, SIZE)
				if (built.slots.length === 0) throw new Error('no slots produced — try another theme')
				const entries = validateEntries(
					built.slots,
					await generateEntries(generate, t, built.slots)
				)
				const { seq } = await app.dispatch({
					type: 'play',
					params: { theme: t, grid: built.grid, slots: built.slots, entries }
				})
				return app.settled(seq)
			}
		})
	})
})

export type CrosswordApp = typeof app

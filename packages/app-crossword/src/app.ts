import { ai } from '@justfiles/app/capabilities/ai'
import { defineApp } from '@justfiles/app/kernel/sdk'
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

export const app = defineApp({
	init: initialState,
	capabilities: { ai: ai({ scopes: [] }) },
	handlers: {
		start: {
			description: 'Generate and start a new crossword for a theme.',
			schema: v.object({ theme: v.string() }),
			examples: [{ params: { theme: 'space' } }],
			async handler({ theme }, ctx) {
				const t = theme.trim()
				if (!t) throw new Error('theme is required')
				const seeds = await generateSeeds(ctx.capabilities.ai, t)
				if (seeds.length === 0) throw new Error('AI returned no usable words')
				const built = buildPuzzle(seeds, SIZE)
				if (built.slots.length === 0) throw new Error('no slots produced — try another theme')
				const entries = validateEntries(
					built.slots,
					await generateEntries(ctx.capabilities.ai, t, built.slots)
				)
				return playState(t, built.grid, built.slots, entries)
			}
		},
		seeds: {
			description:
				'Submit themed seed words. Triggers grid generation and returns slots needing answers.',
			schema: v.object({ words: v.array(v.string()) }),
			examples: [{ params: { words: ['ORBIT', 'COMET', 'NEBULA', 'APOLLO'] } }],
			handler({ words }, ctx) {
				if (!ctx.state.theme) throw new Error('no theme — run start first')
				const seeds = words.map(upper).filter((w) => w.length >= 2)
				if (seeds.length === 0) throw new Error('words must include at least one usable word')
				const built = buildPuzzle(seeds, SIZE)
				if (built.slots.length === 0) throw new Error('no slots produced — try different seeds')
				const puzzle = {
					theme: ctx.state.theme,
					grid: built.grid,
					slots: built.slots,
					entries: {}
				}
				return {
					...ctx.state,
					phase: 'awaiting-fill' as const,
					puzzle,
					userGrid: {},
					revealed: [],
					wrong: [],
					briefing: fillBriefing(built.slots)
				}
			}
		},
		fill: {
			description: 'Provide answer + clue for every slot. Each answer must match its slot pattern.',
			schema: v.object({
				entries: v.array(v.object({ slotId: v.string(), answer: v.string(), clue: v.string() }))
			}),
			handler({ entries }, ctx) {
				const prev = ctx.state.puzzle
				if (!prev) throw new Error('no puzzle to fill — run seeds first')
				const nextEntries = validateEntries(
					prev.slots,
					entries.map((e) => ({ slotId: e.slotId, answer: upper(e.answer), clue: e.clue }))
				)
				return playState(prev.theme, prev.grid, prev.slots, nextEntries)
			}
		},
		enter: {
			description: 'Enter or clear one user letter in the grid.',
			schema: v.object({ row: v.number(), col: v.number(), letter: v.string() }),
			handler({ row, col, letter }, ctx) {
				if (!ctx.state.puzzle || ctx.state.phase === 'solved') return ctx.state
				const key = cellKey(row, col)
				if (ctx.state.revealed.includes(key)) return ctx.state
				const nextGrid = { ...ctx.state.userGrid }
				const value = upper(letter)[0]
				if (value) nextGrid[key] = value
				else delete nextGrid[key]
				return solved({
					...ctx.state,
					userGrid: nextGrid,
					wrong: ctx.state.wrong.filter((k) => k !== key)
				})
			}
		},
		reveal: {
			description: 'Reveal solution letters for selected cells.',
			schema: v.object({ cells: v.array(v.string()) }),
			handler({ cells }, ctx) {
				const puzzle = ctx.state.puzzle
				if (!puzzle || ctx.state.phase === 'solved') return ctx.state
				const userGrid = { ...ctx.state.userGrid }
				const revealed = new Set(ctx.state.revealed)
				for (const cell of cells as Cell[]) {
					const [r, c] = parseCell(cell)
					const answer = puzzle.grid[r]?.[c]
					if (answer && answer !== '#') {
						userGrid[cell] = answer
						revealed.add(cell)
					}
				}
				return solved({ ...ctx.state, userGrid, revealed: [...revealed], wrong: [] })
			}
		},
		check: {
			description: 'Mark selected user letters as wrong when they do not match the solution.',
			schema: v.object({ cells: v.array(v.string()) }),
			handler({ cells }, ctx) {
				const puzzle = ctx.state.puzzle
				if (!puzzle) return ctx.state
				const wrong = new Set(ctx.state.wrong)
				for (const cell of cells as Cell[]) {
					const [r, c] = parseCell(cell)
					const answer = puzzle.grid[r]?.[c]
					if (!answer || answer === '#') continue
					if (ctx.state.userGrid[cell] !== answer) wrong.add(cell)
					else wrong.delete(cell)
				}
				return { ...ctx.state, wrong: [...wrong] }
			}
		}
	}
})

export type CrosswordApp = typeof app

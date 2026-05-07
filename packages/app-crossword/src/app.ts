import { defineApp, setup } from '@justfiles/app'
import { Type } from 'typebox'
import { addBlocks } from './blocks.js'
import { place } from './placement.js'
import {
	cellKey,
	gradeAll,
	gradeCells,
	isPlayCell,
	isSolved,
	maskGrid,
	slotCells,
	solutionAt
} from './play.js'
import { slots as detectSlots } from './slots.js'
import type { Cell, Grid, Play, Slot } from './types.js'

const SIZE = 11

type Entry = { slotId: string; answer: string; clue: string }

const BAD_CLUE_MARKERS = ['abbreviated', 'clipped', 'shortened', 'shorter', 'to fit', 'truncated']

type Context = {
	theme?: string
	candidates: string[]
	grid?: Grid
	slots: Slot[]
	unplaced: string[]
	entries: Record<string, Entry>
	play: Play
}

function freshPlay(): Play {
	return {
		userGrid: {},
		revealed: [],
		wrongCells: [],
		hintsUsed: 0,
		checksUsed: 0,
		submitCount: 0
	}
}

function generatePuzzle(seeds: string[], size: number) {
	const { grid: placed, placements, unplaced } = place(seeds, size)
	const grid = addBlocks(placed, placements)
	return { grid, slots: detectSlots(grid), unplaced }
}

function bakeEntries(grid: Grid, slots: Slot[], entries: Record<string, Entry>): Grid {
	const rows = grid.map((r) => r.split(''))
	for (const slot of slots) {
		const entry = entries[slot.id]
		if (!entry) continue
		for (let i = 0; i < entry.answer.length; i++) {
			const r = slot.direction === 'across' ? slot.row : slot.row + i
			const c = slot.direction === 'across' ? slot.col + i : slot.col
			const row = rows[r]
			if (row && entry.answer[i]) row[c] = entry.answer[i] ?? '.'
		}
	}
	// Cells still '.' aren't part of any answered slot — block them out so the
	// solver only ever sees clued cells.
	for (const row of rows) {
		for (let c = 0; c < row.length; c++) {
			if (row[c] === '.') row[c] = '#'
		}
	}
	return rows.map((r) => r.join(''))
}

function matchesPattern(answer: string, pattern: string): boolean {
	if (answer.length !== pattern.length) return false
	for (let i = 0; i < pattern.length; i++) {
		const p = pattern[i]
		if (p === '?') continue
		if (p !== answer[i]) return false
	}
	return true
}

function admitsShortening(clue: string): boolean {
	const text = clue.toLowerCase()
	return BAD_CLUE_MARKERS.some((marker) => text.includes(marker))
}

function revealsAnswer(clue: string, answer: string): boolean {
	const words = clue.toUpperCase().match(/[A-Z]+/g)
	return words?.includes(answer.toUpperCase()) ?? false
}

function resetContext(theme?: string): Context {
	return { theme, candidates: [], slots: [], unplaced: [], entries: {}, play: freshPlay() }
}

const themeNarration = (theme: string) =>
	[
		'Internal instruction for the agent:',
		`The user picked theme "${theme}". You are the crossword constructor.`,
		`Generate 8-12 ${theme}-themed single-word answers yourself.`,
		'Do not ask the user for word ideas — that is your job, not theirs.',
		'Each answer must be uppercase A-Z, 3-8 letters, no spaces or punctuation.',
		'Never abbreviate, clip, truncate, or shorten a longer themed term to make it fit. If the canonical answer is too long or needs spaces/punctuation, choose a different canonical single-word answer instead.',
		'Do not use fragments, prefixes, initials, acronyms, nicknames, or partial names unless that exact form is the standard canonical answer.',
		'Spread across different facets of the theme — e.g. people/characters, places, objects, concepts, actions, lesser-known deep cuts. Avoid only the obvious top-of-mind picks.',
		'Do not reveal answer words in visible chat. Put answer words only in tool arguments.',
		'Immediately call seeds({ candidates: [...] }) with your words.'
	].join(' ')

const regenNarration = [
	'Internal instruction for the agent:',
	'Puzzle discarded. The previous seeds did not work.',
	'Generate 8-12 NEW seed words for the theme — pick different words than before, especially avoiding any that produced impossible patterns. Spread across different facets (people, places, objects, concepts, deep cuts).',
	'Use only complete canonical single-word answers. Never abbreviate, clip, truncate, or shorten a longer themed term to make it fit.',
	'Do not reveal answer words in visible chat. Put answer words only in tool arguments.',
	'Immediately call seeds({ candidates: [...] }) with your new words.'
].join(' ')

function applyReveal(ctx: Context, cells: Cell[]): Context {
	const grid = ctx.grid
	if (!grid) return ctx
	const userGrid = { ...ctx.play.userGrid }
	const revealed = new Set(ctx.play.revealed)
	let added = 0
	for (const key of cells) {
		const [r, c] = key.split(',').map(Number) as [number, number]
		if (!isPlayCell(grid, r, c)) continue
		const sol = solutionAt(grid, r, c)
		if (!sol || sol === '#') continue
		userGrid[key] = sol
		if (!revealed.has(key)) {
			revealed.add(key)
			added++
		}
	}
	const wrongCells = ctx.play.wrongCells.filter(
		(k) =>
			!revealed.has(k) ||
			userGrid[k] !== solutionAt(grid, ...(k.split(',').map(Number) as [number, number]))
	)
	const finishedAt = isSolved(grid, userGrid)
		? (ctx.play.finishedAt ?? Date.now())
		: ctx.play.finishedAt
	return {
		...ctx,
		play: {
			...ctx.play,
			userGrid,
			revealed: Array.from(revealed),
			wrongCells,
			hintsUsed: ctx.play.hintsUsed + added,
			finishedAt
		}
	}
}

const playRouter = ({ context }: { context: Context }) =>
	context.grid && isSolved(context.grid, context.play.userGrid) ? 'solved' : 'playing'

const isSolver = ({ actor }: { actor: { kind?: string } }) => actor.kind !== 'agent'

type View = { state: string; context: Context }

function viewFor(snapshot: { state: string; context: Context }, actor: { kind?: string }): View {
	if (actor.kind === 'agent') return snapshot
	if (snapshot.state === 'solved') return snapshot
	const ctx = snapshot.context
	if (!ctx.grid) return snapshot
	const maskedEntries: Record<string, Entry> = {}
	for (const [id, e] of Object.entries(ctx.entries)) {
		maskedEntries[id] = { slotId: e.slotId, clue: e.clue, answer: '' }
	}
	return {
		state: snapshot.state,
		context: { ...ctx, grid: maskGrid(ctx.grid), entries: maskedEntries }
	}
}

const engine = setup().engine({
	initial: 'init' as 'init' | 'themed' | 'filling' | 'review' | 'playing' | 'solved',
	context: resetContext(),
	view: viewFor,
	states: {
		init: {
			on: {
				theme: {
					description: 'Set the puzzle theme.',
					schema: Type.Object({ theme: Type.String() }),
					target: 'themed',
					actor: 'agent',
					actions: ({ action }) => resetContext((action.payload as { theme: string }).theme),
					narrate: ({ action }) => themeNarration((action.payload as { theme: string }).theme)
				}
			}
		},
		themed: {
			on: {
				theme: {
					description: 'Change the puzzle theme.',
					schema: Type.Object({ theme: Type.String() }),
					target: 'themed',
					actor: 'agent',
					actions: ({ action }) => resetContext((action.payload as { theme: string }).theme),
					narrate: ({ action }) => themeNarration((action.payload as { theme: string }).theme)
				},
				seeds: {
					description: 'Submit themed seed words. Triggers grid generation.',
					schema: Type.Object({ candidates: Type.Array(Type.String()) }),
					target: 'filling',
					actor: 'agent',
					actions: ({ context, action }) => {
						const candidates = (action.payload as { candidates: string[] }).candidates.map((c) =>
							c.toUpperCase()
						)
						const { grid, slots, unplaced } = generatePuzzle(candidates, SIZE)
						return {
							...(context as Context),
							candidates,
							grid,
							slots,
							unplaced,
							entries: {},
							play: freshPlay()
						}
					},
					narrate: ({ next }) => {
						const ctx = next.context as Context
						const placed = ctx.candidates.length - ctx.unplaced.length
						const lines = [
							'Internal instruction for the agent:',
							`Puzzle generated. Placed ${placed} of ${ctx.candidates.length} seeds.`
						]
						if (ctx.unplaced.length > 0) lines.push(`Unplaced: ${ctx.unplaced.join(', ')}.`)
						if (ctx.slots.length === 0) {
							lines.push('No slots in the puzzle. Immediately call fill({ entries: [] }).')
						} else {
							lines.push(`Slots needing answer + clue (${ctx.slots.length}):`)
							for (const s of ctx.slots) {
								lines.push(`  ${s.id} ${s.direction} ${s.pattern} (${s.length} letters)`)
							}
							lines.push(
								'For each slot, pick an answer matching the pattern (? = any letter) and write a thematic clue yourself.',
								'Every answer must be a complete canonical word/name for its clue. Never abbreviate, clip, truncate, or shorten a longer themed term just to fit the slot.',
								'Never include the answer itself in its clue, including inside quoted phrases or examples.',
								'If only a fragment, prefix, initialism, nickname, or partial name would fit, pick a different real answer or call regenerate({}).',
								'Do not ask the user — you are the constructor.',
								'Do not reveal answer words in visible chat. Put answer words only in tool arguments.',
								'Immediately call fill({ entries: [{ slotId, answer, clue }, ...] }).',
								'If a slot pattern has no possible real word (e.g. impossible letter combination), or fill is rejected and you cannot fix it, call regenerate({}) to discard this puzzle and try again with different seed words.'
							)
						}
						return lines.join('\n')
					}
				}
			}
		},
		filling: {
			on: {
				fill: {
					description:
						'Provide answer and clue for every slot in the puzzle. Each answer must match its slot pattern.',
					schema: Type.Object({
						entries: Type.Array(
							Type.Object({
								slotId: Type.String(),
								answer: Type.String(),
								clue: Type.String()
							})
						)
					}),
					target: 'review',
					actor: 'agent',
					guard: ({ context, action }) => {
						const entries = (action.payload as { entries?: Entry[] }).entries
						if (!Array.isArray(entries)) return true
						const slotMap = new Map((context as Context).slots.map((s) => [s.id, s]))
						for (const e of entries) {
							const slot = slotMap.get(e.slotId)
							if (!slot) return false
							const answer = e.answer.toUpperCase()
							if (!matchesPattern(answer, slot.pattern)) return false
							if (admitsShortening(e.clue)) return false
							if (revealsAnswer(e.clue, answer)) return false
						}
						return true
					},
					actions: ({ context, action }) => {
						const ctx = context as Context
						const { entries } = action.payload as { entries: Entry[] }
						const map: Record<string, Entry> = {}
						for (const e of entries) {
							map[e.slotId] = { ...e, answer: e.answer.toUpperCase() }
						}
						const baked = ctx.grid ? bakeEntries(ctx.grid, ctx.slots, map) : ctx.grid
						return { ...ctx, entries: map, grid: baked }
					},
					narrate: () =>
						'Puzzle filled. Do not reveal answers in visible chat. Call approve() to lock it in or regenerate() to start over.'
				},
				regenerate: {
					description: 'Discard the current puzzle and start over with new seeds.',
					schema: Type.Object({}),
					target: 'themed',
					actor: 'agent',
					actions: ({ context }) => resetContext((context as Context).theme),
					narrate: () => regenNarration
				}
			}
		},
		review: {
			on: {
				approve: {
					description: 'Approve the puzzle. The user can start solving.',
					schema: Type.Object({}),
					target: 'playing',
					actor: 'agent',
					actions: ({ context }) => ({
						...(context as Context),
						play: { ...freshPlay(), startedAt: Date.now() }
					}),
					narrate: () =>
						'Puzzle approved. Tell the user the game is ready to play. Do not reveal answers.'
				},
				regenerate: {
					description: 'Discard the puzzle and start over with new seeds.',
					schema: Type.Object({}),
					target: 'themed',
					actor: 'agent',
					actions: ({ context }) => resetContext((context as Context).theme),
					narrate: () => regenNarration
				}
			}
		},
		playing: {
			on: {
				enterLetter: {
					description: 'Type a letter into a cell. Use empty letter to clear.',
					schema: Type.Object({
						row: Type.Integer({ minimum: 0 }),
						col: Type.Integer({ minimum: 0 }),
						letter: Type.String({ minLength: 0, maxLength: 1 })
					}),
					actor: isSolver,
					target: playRouter,
					guard: ({ context, action }) => {
						const p = action.payload as { row?: number; col?: number; letter?: string }
						if (typeof p.row !== 'number' || typeof p.col !== 'number') return true
						const ctx = context as Context
						if (!ctx.grid || !isPlayCell(ctx.grid, p.row, p.col)) return false
						if (ctx.play.revealed.includes(cellKey(p.row, p.col))) return false
						if (typeof p.letter === 'string' && p.letter.length > 0) {
							const code = p.letter.charCodeAt(0)
							if (code < 65 || code > 90) return false
						}
						return true
					},
					actions: ({ context, action }) => {
						const ctx = context as Context
						const { row, col, letter } = action.payload as {
							row: number
							col: number
							letter: string
						}
						const key = cellKey(row, col)
						const userGrid = { ...ctx.play.userGrid }
						if (letter === '') delete userGrid[key]
						else userGrid[key] = letter
						const wrongCells = ctx.play.wrongCells.filter((k) => k !== key)
						const finishedAt =
							ctx.grid && isSolved(ctx.grid, userGrid)
								? (ctx.play.finishedAt ?? Date.now())
								: ctx.play.finishedAt
						return { ...ctx, play: { ...ctx.play, userGrid, wrongCells, finishedAt } }
					}
				},
				clearCell: {
					description: 'Clear the letter in a cell.',
					schema: Type.Object({
						row: Type.Integer({ minimum: 0 }),
						col: Type.Integer({ minimum: 0 })
					}),
					actor: isSolver,
					target: 'playing',
					guard: ({ context, action }) => {
						const p = action.payload as { row?: number; col?: number }
						if (typeof p.row !== 'number' || typeof p.col !== 'number') return true
						const ctx = context as Context
						if (!ctx.grid) return false
						return !ctx.play.revealed.includes(cellKey(p.row, p.col))
					},
					actions: ({ context, action }) => {
						const ctx = context as Context
						const { row, col } = action.payload as { row: number; col: number }
						const key = cellKey(row, col)
						const userGrid = { ...ctx.play.userGrid }
						delete userGrid[key]
						return {
							...ctx,
							play: {
								...ctx.play,
								userGrid,
								wrongCells: ctx.play.wrongCells.filter((k) => k !== key)
							}
						}
					}
				},
				clearAll: {
					description: 'Clear every user-entered letter. Revealed cells stay locked.',
					schema: Type.Object({}),
					actor: isSolver,
					target: 'playing',
					actions: ({ context }) => {
						const ctx = context as Context
						const revealed = new Set(ctx.play.revealed)
						const userGrid: Record<Cell, string> = {}
						for (const key of revealed) {
							const existing = ctx.play.userGrid[key]
							if (existing !== undefined) userGrid[key] = existing
						}
						return { ...ctx, play: { ...ctx.play, userGrid, wrongCells: [] } }
					}
				},
				revealLetter: {
					description: 'Reveal the correct letter for one cell. Locks the cell.',
					schema: Type.Object({
						row: Type.Integer({ minimum: 0 }),
						col: Type.Integer({ minimum: 0 })
					}),
					actor: isSolver,
					target: playRouter,
					guard: ({ context, action }) => {
						const p = action.payload as { row?: number; col?: number }
						if (typeof p.row !== 'number' || typeof p.col !== 'number') return true
						const ctx = context as Context
						return !!ctx.grid && isPlayCell(ctx.grid, p.row, p.col)
					},
					actions: ({ context, action }) => {
						const { row, col } = action.payload as { row: number; col: number }
						return applyReveal(context as Context, [cellKey(row, col)])
					}
				},
				revealWord: {
					description: 'Reveal every letter in a slot. Locks the cells.',
					schema: Type.Object({ slotId: Type.String() }),
					actor: isSolver,
					target: playRouter,
					guard: ({ context, action }) => {
						const p = action.payload as { slotId?: string }
						if (typeof p.slotId !== 'string') return true
						return (context as Context).slots.some((s) => s.id === p.slotId)
					},
					actions: ({ context, action }) => {
						const { slotId } = action.payload as { slotId: string }
						const ctx = context as Context
						const slot = ctx.slots.find((s) => s.id === slotId)
						if (!slot) return ctx
						return applyReveal(ctx, slotCells(slot))
					}
				},
				revealPuzzle: {
					description: 'Reveal every letter and end the puzzle.',
					schema: Type.Object({}),
					actor: isSolver,
					target: 'solved',
					actions: ({ context }) => {
						const ctx = context as Context
						if (!ctx.grid) return ctx
						const all: Cell[] = []
						for (let r = 0; r < ctx.grid.length; r++) {
							const row = ctx.grid[r] ?? ''
							for (let c = 0; c < row.length; c++) {
								if (row[c] !== '#') all.push(cellKey(r, c))
							}
						}
						const revealed = applyReveal(ctx, all)
						return {
							...revealed,
							play: { ...revealed.play, finishedAt: revealed.play.finishedAt ?? Date.now() }
						}
					}
				},
				checkLetter: {
					description: 'Check whether one cell is correct. Marks it wrong if not.',
					schema: Type.Object({
						row: Type.Integer({ minimum: 0 }),
						col: Type.Integer({ minimum: 0 })
					}),
					actor: isSolver,
					target: 'playing',
					guard: ({ context, action }) => {
						const p = action.payload as { row?: number; col?: number }
						if (typeof p.row !== 'number' || typeof p.col !== 'number') return true
						const ctx = context as Context
						return !!ctx.grid && isPlayCell(ctx.grid, p.row, p.col)
					},
					actions: ({ context, action }) => {
						const ctx = context as Context
						if (!ctx.grid) return ctx
						const { row, col } = action.payload as { row: number; col: number }
						const key = cellKey(row, col)
						const wrong = gradeCells(ctx.grid, ctx.play.userGrid, [key])
						const wrongCells = mergeWrong(ctx.play.wrongCells, [key], wrong)
						return {
							...ctx,
							play: { ...ctx.play, wrongCells, checksUsed: ctx.play.checksUsed + 1 }
						}
					}
				},
				checkWord: {
					description: 'Check every cell in a slot. Marks wrong cells.',
					schema: Type.Object({ slotId: Type.String() }),
					actor: isSolver,
					target: 'playing',
					guard: ({ context, action }) => {
						const p = action.payload as { slotId?: string }
						if (typeof p.slotId !== 'string') return true
						return (context as Context).slots.some((s) => s.id === p.slotId)
					},
					actions: ({ context, action }) => {
						const ctx = context as Context
						if (!ctx.grid) return ctx
						const slot = ctx.slots.find(
							(s) => s.id === (action.payload as { slotId: string }).slotId
						)
						if (!slot) return ctx
						const cells = slotCells(slot)
						const wrong = gradeCells(ctx.grid, ctx.play.userGrid, cells)
						const wrongCells = mergeWrong(ctx.play.wrongCells, cells, wrong)
						return {
							...ctx,
							play: { ...ctx.play, wrongCells, checksUsed: ctx.play.checksUsed + 1 }
						}
					}
				},
				checkPuzzle: {
					description: 'Check every cell. Marks wrong cells.',
					schema: Type.Object({}),
					actor: isSolver,
					target: 'playing',
					actions: ({ context }) => {
						const ctx = context as Context
						if (!ctx.grid) return ctx
						const wrongCells = gradeAll(ctx.grid, ctx.play.userGrid)
						return {
							...ctx,
							play: { ...ctx.play, wrongCells, checksUsed: ctx.play.checksUsed + 1 }
						}
					}
				},
				submit: {
					description: 'Submit the puzzle for final grading.',
					schema: Type.Object({}),
					actor: isSolver,
					target: playRouter,
					actions: ({ context }) => {
						const ctx = context as Context
						if (!ctx.grid) return ctx
						const wrongCells = gradeAll(ctx.grid, ctx.play.userGrid)
						const solved = wrongCells.length === 0
						return {
							...ctx,
							play: {
								...ctx.play,
								wrongCells,
								submitCount: ctx.play.submitCount + 1,
								finishedAt: solved ? (ctx.play.finishedAt ?? Date.now()) : ctx.play.finishedAt
							}
						}
					}
				},
				reset: {
					description:
						'Wipe entered letters and start the solve fresh. NYT-style: revealed cells stay locked, hint and check counters persist.',
					schema: Type.Object({}),
					actor: isSolver,
					target: 'playing',
					actions: ({ context }) => {
						const ctx = context as Context
						const revealed = new Set(ctx.play.revealed)
						const userGrid: Record<Cell, string> = {}
						for (const key of revealed) {
							const existing = ctx.play.userGrid[key]
							if (existing !== undefined) userGrid[key] = existing
						}
						return {
							...ctx,
							play: {
								...ctx.play,
								userGrid,
								wrongCells: [],
								finishedAt: undefined
							}
						}
					}
				}
			}
		},
		solved: {}
	}
})

function mergeWrong(prev: Cell[], scope: Cell[], wrong: Cell[]): Cell[] {
	const scopeSet = new Set(scope)
	const kept = prev.filter((k) => !scopeSet.has(k))
	const wrongSet = new Set(wrong)
	for (const k of wrongSet) if (!kept.includes(k)) kept.push(k)
	return kept
}

export default defineApp({
	name: 'Crossword',
	description: 'Crossword puzzle builder.',
	icon: 'icon.svg',
	engine,
	agent: {
		briefing: [
			'A crossword puzzle builder is open. You are the constructor — the user is the solver.',
			'Step 1: Ask the user what theme they want.',
			'Step 2: Call theme({ theme }) with their answer.',
			'Steps 3+: Generate seed words and clues yourself; do not ask the user for word ideas.',
			'Never reveal crossword answers in visible chat. When the puzzle is approved, simply tell the user the game is ready to play.',
			'Once approved, the user solves the puzzle. You do not enter letters for them.',
			'Follow the per-step instructions returned after each tool call.'
		].join(' ')
	}
})

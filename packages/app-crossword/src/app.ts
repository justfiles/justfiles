import { defineApp, defineEngine } from '@justfiles/app'
import { Type } from 'typebox'
import { addBlocks } from './blocks.js'
import { place } from './placement.js'
import { slots as detectSlots } from './slots.js'
import type { Grid, Slot } from './types.js'

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
}

function generatePuzzle(seeds: string[], size: number) {
	const { grid: placed, placements, unplaced } = place(seeds, size)
	const grid = addBlocks(placed, placements)
	return { grid, slots: detectSlots(grid), unplaced }
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
	return { theme, candidates: [], slots: [], unplaced: [], entries: {} }
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
		'Immediately call seeds({ candidates: [...] }) with your words.'
	].join(' ')

const engine = defineEngine({
	initial: 'init' as 'init' | 'themed' | 'filling' | 'review' | 'ready',
	context: resetContext(),
	states: {
		init: {
			on: {
				theme: {
					description: 'Set the puzzle theme.',
					schema: Type.Object({ theme: Type.String() }),
					target: 'themed',
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
					actions: ({ action }) => resetContext((action.payload as { theme: string }).theme),
					narrate: ({ action }) => themeNarration((action.payload as { theme: string }).theme)
				},
				seeds: {
					description: 'Submit themed seed words. Triggers grid generation.',
					schema: Type.Object({ candidates: Type.Array(Type.String()) }),
					target: 'filling',
					actions: ({ context, action }) => {
						const candidates = (action.payload as { candidates: string[] }).candidates.map((c) =>
							c.toUpperCase()
						)
						const { grid, slots, unplaced } = generatePuzzle(candidates, SIZE)
						return { ...context, candidates, grid, slots, unplaced, entries: {} }
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
						const { entries } = action.payload as { entries: Entry[] }
						const map: Record<string, Entry> = {}
						for (const e of entries) {
							map[e.slotId] = { ...e, answer: e.answer.toUpperCase() }
						}
						return { ...(context as Context), entries: map }
					},
					narrate: () =>
						'Puzzle filled. Show it to the user. Call approve() to lock it in or regenerate() to start over.'
				},
				regenerate: {
					description: 'Discard the current puzzle and start over with new seeds.',
					schema: Type.Object({}),
					target: 'themed',
					actions: ({ context }) => resetContext((context as Context).theme),
					narrate: () =>
						[
							'Internal instruction for the agent:',
							'Puzzle discarded. The previous seeds did not work.',
							'Generate 8-12 NEW seed words for the theme — pick different words than before, especially avoiding any that produced impossible patterns. Spread across different facets (people, places, objects, concepts, deep cuts).',
							'Use only complete canonical single-word answers. Never abbreviate, clip, truncate, or shorten a longer themed term to make it fit.',
							'Immediately call seeds({ candidates: [...] }) with your new words.'
						].join(' ')
				}
			}
		},
		review: {
			on: {
				approve: {
					description: 'Approve the puzzle and lock it in.',
					schema: Type.Object({}),
					target: 'ready',
					narrate: () => 'Puzzle is ready. The user can now play it.'
				},
				regenerate: {
					description: 'Discard the puzzle and start over with new seeds.',
					schema: Type.Object({}),
					target: 'themed',
					actions: ({ context }) => resetContext((context as Context).theme),
					narrate: () =>
						[
							'Internal instruction for the agent:',
							'Puzzle discarded. The previous seeds did not work.',
							'Generate 8-12 NEW seed words for the theme — pick different words than before, especially avoiding any that produced impossible patterns. Spread across different facets (people, places, objects, concepts, deep cuts).',
							'Use only complete canonical single-word answers. Never abbreviate, clip, truncate, or shorten a longer themed term to make it fit.',
							'Immediately call seeds({ candidates: [...] }) with your new words.'
						].join(' ')
				}
			}
		},
		ready: {}
	}
})

export default defineApp({
	name: 'Crossword',
	description: 'Crossword puzzle builder.',
	engine,
	agent: {
		briefing: [
			'A crossword puzzle builder is open. You are the constructor — the user is the solver.',
			'Step 1: Ask the user what theme they want.',
			'Step 2: Call theme({ theme }) with their answer.',
			'Steps 3+: Generate seed words and clues yourself; do not ask the user for word ideas.',
			'Follow the per-step instructions returned after each tool call.'
		].join(' ')
	}
})

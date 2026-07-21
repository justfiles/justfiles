import { defineApp } from '@justfiles/app'
import { newDoc, type PixelDoc } from './doc.ts'

// Minimal phase-1 state: just the artwork. Tools, colour/palette selection and
// undo arrive in phase 2 — kept out of state until they exist.
export type PixelState = { doc: PixelDoc }

// Seed a friendly starter (a 16×16 red heart in the DB16 palette) so a fresh
// install renders something crisp. There are no editing actions yet.
const HEART = [
	'................',
	'................',
	'..666......666..',
	'.66666....66666.',
	'.66666666666666.',
	'.66666666666666.',
	'.66666666666666.',
	'..666666666666..',
	'...6666666666...',
	'....66666666....',
	'.....666666.....',
	'......6666......',
	'.......66.......',
	'................',
	'................',
	'................'
]

export const initialState: PixelState = { doc: { ...newDoc(16), grid: HEART } }

// No tools yet (phase 1 is a static render). The state machine is intentionally
// action-free; phase 2 adds the drawing/palette edges.
export const app = defineApp({ init: initialState })

export type PixelApp = typeof app

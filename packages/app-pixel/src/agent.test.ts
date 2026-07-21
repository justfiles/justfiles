import { describe, expect, it } from 'vitest'
import { app, initialState, type PixelState } from './app.ts'
import { gridDiff } from './bitmap.ts'
import { charToIndex, getPixel, newDoc, type Size } from './doc.ts'

// The acceptance gate for "pixels live in state" (#226): the agent's only view of
// the app is `state` (its eyes) and the public action surface, and it drives both
// through the same reducer the GUI does. `app.dispatch` IS that path — the `app
// run` shell command validates params against each edge's schema and calls it — so
// driving the app here reproduces exactly what the frieren chat agent does, with
// no kernel and no sandbox.
const drive = async (
	state: PixelState,
	type: string,
	params: Record<string, unknown> = {}
): Promise<PixelState> => {
	const out = await app.dispatch({ type, params, actor: 'agent' }, { state })
	return out.state as PixelState
}

const blank = (n: Size): PixelState => ({ ...initialState, doc: newDoc(n) })

// A 16×16 heart in palette index 7 (char '6') — the recognizable shape the agent
// is asked to place from a blank canvas.
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

// Every non-transparent heart cell as the {x,y,i} the agent batches into one
// `setPixels` dispatch.
const heartPixels = HEART.flatMap((row, y) =>
	[...row].flatMap((ch, x) => (ch === '.' ? [] : [{ x, y, i: charToIndex(ch) }]))
)

describe('agent draws from a blank canvas (#216 feature-mapping #1a)', () => {
	it('places a recognizable heart in a single batch setPixels dispatch', async () => {
		const drawn = await drive(blank(16), 'setPixels', { pixels: heartPixels })
		// One dispatch, one state write — the batch op keeps the count low.
		expect(drawn.doc.grid).toEqual(HEART)
		expect(drawn.doc.width).toBe(16)
	})

	it('composes shapes via fillRect, drawLine and floodFill', async () => {
		let s = blank(16)
		s = await drive(s, 'fillRect', { x: 0, y: 0, w: 6, h: 6, i: 1 })
		expect(getPixel(s.doc.grid, 3, 3)).toBe(1)

		s = await drive(s, 'drawLine', { x0: 0, y0: 0, x1: 5, y1: 5, i: 2 })
		expect(getPixel(s.doc.grid, 2, 2)).toBe(2) // the diagonal overwrote the fill
		expect(getPixel(s.doc.grid, 5, 0)).toBe(1) // off the diagonal is still the fill

		// The diagonal splits the block; a bucket in the lower-left triangle stops at it.
		s = await drive(s, 'floodFill', { x: 0, y: 5, i: 3 })
		expect(getPixel(s.doc.grid, 0, 5)).toBe(3)
		expect(getPixel(s.doc.grid, 1, 5)).toBe(3)
		expect(getPixel(s.doc.grid, 5, 0)).toBe(1) // the upper-right triangle is untouched
		expect(getPixel(s.doc.grid, 2, 2)).toBe(2) // the diagonal is untouched
	})

	it('rejects out-of-bounds coordinates (tight schema → invalid input impossible)', async () => {
		await expect(
			drive(blank(16), 'setPixels', { pixels: [{ x: 64, y: 0, i: 1 }] })
		).rejects.toThrow()
		await expect(
			drive(blank(16), 'drawLine', { x0: 0, y0: 0, x1: 0, y1: 64, i: 1 })
		).rejects.toThrow()
	})
})

describe('agent recolours the whole sprite (#216 feature-mapping #1b)', () => {
	// A cool night scheme, same length as the DB16 default so the starter heart
	// (index 7) recolours instead of dropping out.
	const NIGHT = [
		'#0d0b1f',
		'#161335',
		'#1f1b4d',
		'#2a2560',
		'#352f73',
		'#413a87',
		'#4f479c',
		'#5e57b0',
		'#1b2b52',
		'#264072',
		'#325693',
		'#3f6fb0',
		'#5a90c9',
		'#84b4e0',
		'#bcd7f2',
		'#eef5ff'
	]

	it('swaps to a night palette in one dispatch with zero pixel edits', async () => {
		const before = initialState // the starter heart at index 7
		const after = await drive(before, 'setPalette', { palette: NIGHT })
		expect(after.doc.palette).toEqual(NIGHT)
		// Instant global recolour: not a single pixel changed.
		expect(after.doc.grid).toEqual(before.doc.grid)
		expect(gridDiff(before.doc.grid, after.doc.grid)).toEqual([])
	})

	it('recolours one entry, updating every pixel drawn with it, without touching pixels', async () => {
		const before = initialState
		const after = await drive(before, 'setPaletteColor', { i: 7, color: '#1a1c2c' })
		expect(after.doc.palette[6]).toBe('#1a1c2c')
		expect(after.doc.palette[0]).toBe(before.doc.palette[0]) // other entries intact
		expect(after.doc.grid).toEqual(before.doc.grid)
	})
})

describe('a human undo folds in the agent edits (#216 feature-mapping #1c)', () => {
	it('shares one timeline: undo reaches back across the agent and human edits', async () => {
		// The GUI pushes a snapshot on every committed grid revision, regardless of who
		// dispatched it (human stroke or agent action), and a restore replays a diff via
		// setPixels. Model that timeline over the shared reducer.
		const timeline: string[][] = []
		let state = blank(16)
		timeline.push(state.doc.grid)

		// Agent edit: draw the heart.
		state = await drive(state, 'setPixels', { pixels: heartPixels })
		timeline.push(state.doc.grid)

		// Human edit: a stroke that erases the heart's tip.
		state = await drive(state, 'setPixels', {
			pixels: [
				{ x: 7, y: 12, i: 0 },
				{ x: 8, y: 12, i: 0 }
			]
		})
		timeline.push(state.doc.grid)

		// Human clicks Undo → restore the previous snapshot: it lands on the agent's heart.
		const heart = timeline[timeline.length - 2] as string[]
		state = await drive(state, 'setPixels', { pixels: gridDiff(state.doc.grid, heart) })
		expect(state.doc.grid).toEqual(HEART)

		// Undo again → back to the blank canvas the agent started from.
		const start = timeline[0] as string[]
		state = await drive(state, 'setPixels', { pixels: gridDiff(state.doc.grid, start) })
		expect(state.doc.grid).toEqual(newDoc(16).grid)
	})
})

describe('state is compact + legible (`app state`)', () => {
	it('serializes a readable char-grid + palette', () => {
		const json = JSON.stringify(initialState)
		// The grid is an ASCII-art char matrix an LLM can read directly, not an int blob.
		expect(json).toContain('.66666666666666.')
		expect(json).toContain('#d04648') // a palette entry, as #rrggbb
		expect(initialState.doc.grid).toHaveLength(16)
	})

	it('stays well under 5 KB even for a fully-painted 64×64 canvas', async () => {
		// Worst case for size: every cell painted (a char per pixel, so content never
		// changes the byte count) plus the default 16-colour palette and the selection.
		const filled = await drive(blank(64), 'fillRect', { x: 0, y: 0, w: 64, h: 64, i: 1 })
		const bytes = new TextEncoder().encode(JSON.stringify(filled)).length
		expect(bytes).toBeLessThan(5 * 1024)
		expect(filled.doc.grid).toHaveLength(64)
		expect(filled.doc.grid[0]).toBe('0'.repeat(64))
	})
})

import { describe, expect, it } from 'vitest'
import { app, initialState, type PixelState } from './app.ts'
import { charToIndex, encodeText, getPixel, newDoc } from './doc.ts'

// setGrid is a reducer edge; drive it through the same `app.dispatch` path the
// `app run` shell uses (params already validated + stdin-injected there).
const setGrid = async (state: PixelState, params: Record<string, unknown>): Promise<PixelState> => {
	const out = await app.dispatch({ type: 'setGrid', params, actor: 'agent' }, { state })
	return out.state as PixelState
}

const drive = async (
	state: PixelState,
	type: string,
	params: Record<string, unknown> = {}
): Promise<PixelState> => {
	const out = await app.dispatch({ type, params, actor: 'agent' }, { state })
	return out.state as PixelState
}

// `show` is a procedure — it only reads `app.state`, so a handle that stubs the
// rest is enough.
const show = (state: PixelState, ruler?: boolean): Promise<string> =>
	app.runProcedure('show', ruler === undefined ? {} : { ruler }, {
		state,
		dispatch: async () => ({ seq: 0 }),
		settled: async () => state,
		invoke: async () => undefined
	} as never) as Promise<string>

// Arbitrary square size (not just the Size union) so ruler width behaviour is testable.
const blank = (n: number): PixelState => ({
	...initialState,
	doc: { ...newDoc(16), width: n, height: n, grid: Array.from({ length: n }, () => '.'.repeat(n)) }
})
const SIX = charToIndex('6') // 7

describe('setGrid — stamp a char-grid patch', () => {
	it('draws base62 chars and erases with "."', async () => {
		let s = await setGrid(blank(16), { grid: '.66.\n.66.' })
		expect(getPixel(s.doc.grid, 1, 0)).toBe(SIX)
		expect(getPixel(s.doc.grid, 2, 1)).toBe(SIX)
		expect(getPixel(s.doc.grid, 0, 0)).toBe(0)
		// '.' actively erases: paint a cell, then stamp '.' over it.
		s = await drive(s, 'fillRect', { x: 5, y: 5, w: 1, h: 1, i: 1 })
		expect(getPixel(s.doc.grid, 5, 5)).toBe(1)
		s = await setGrid(s, { grid: '.', x: 5, y: 5 })
		expect(getPixel(s.doc.grid, 5, 5)).toBe(0)
	})

	it('leaves existing pixels untouched where the patch has a space (skip)', async () => {
		let s = await drive(blank(16), 'fillRect', { x: 0, y: 0, w: 3, h: 1, i: 1 })
		expect([0, 1, 2].map((x) => getPixel(s.doc.grid, x, 0))).toEqual([1, 1, 1])
		s = await setGrid(s, { grid: '2 2' }) // col1 is a space → skip
		expect(getPixel(s.doc.grid, 0, 0)).toBe(charToIndex('2'))
		expect(getPixel(s.doc.grid, 1, 0)).toBe(1) // untouched
		expect(getPixel(s.doc.grid, 2, 0)).toBe(charToIndex('2'))
	})

	it('stamps at an x,y origin and clips to the canvas', async () => {
		const s = await setGrid(blank(16), { grid: '66', x: 15, y: 7 })
		expect(getPixel(s.doc.grid, 15, 7)).toBe(SIX) // col 16 is off-canvas → clipped, no throw
		expect(getPixel(s.doc.grid, 0, 0)).toBe(0)
	})

	it('ignores blank lines and # comments (they do not advance the row)', async () => {
		const s = await setGrid(blank(16), { grid: '# a sketch\n\n6\n 6' })
		expect(getPixel(s.doc.grid, 0, 0)).toBe(SIX) // first content row
		expect(getPixel(s.doc.grid, 1, 1)).toBe(SIX) // second content row, leading space skipped
		expect(getPixel(s.doc.grid, 0, 1)).toBe(0)
	})

	it('replaces the whole canvas + palette when piped a full .pixel document', async () => {
		const doc = 'pixel 1\nsize 2 2\npalette\n0 #ffffff\ngrid\n0.\n.0'
		const s = await setGrid(blank(16), { grid: doc, x: 9, y: 9 }) // x,y ignored in full-doc mode
		expect(s.doc.width).toBe(2)
		expect(s.doc.height).toBe(2)
		expect(s.doc.palette).toEqual(['#ffffff'])
		expect(s.doc.grid).toEqual(['0.', '.0'])
	})

	// A patch whose first row is legal cell data that spells `pixel`/`pixel 1` must
	// stamp as a patch, not trip full-doc replacement — without a `size`+`grid`
	// structure, decode would wipe the canvas to a default doc.
	it('stamps a patch whose first row spells `pixel` without wiping the canvas', async () => {
		const s = await setGrid(blank(16), { grid: 'pixel 1' })
		expect(s.doc.width).toBe(16) // canvas untouched — no full-doc replace
		expect(s.doc.height).toBe(16)
		expect(getPixel(s.doc.grid, 0, 0)).toBe(charToIndex('p'))
		expect(getPixel(s.doc.grid, 1, 0)).toBe(charToIndex('i'))
		expect(getPixel(s.doc.grid, 5, 0)).toBe(0) // the space is a skip, not a draw
		expect(getPixel(s.doc.grid, 6, 0)).toBe(charToIndex('1'))
	})
})

describe('show — the canvas as .pixel text', () => {
	it('returns exactly encodeText(doc) with no ruler', async () => {
		expect(await show(initialState)).toBe(encodeText(initialState.doc))
	})

	it('round-trips through setGrid (read-format == write-format)', async () => {
		const text = await show(initialState)
		const back = await setGrid(blank(16), { grid: text })
		expect(back.doc).toEqual(initialState.doc)
	})

	it('overlays column/row numbers with ruler=true', async () => {
		const out = await show(initialState, true)
		expect(out.startsWith('pixel 1\nsize 16 16\n')).toBe(true)
		const lines = out.split('\n')
		const gi = lines.indexOf('grid')
		// grid → tens line (w=16 > 10) → units line → guttered rows
		const tens = lines[gi + 1] ?? ''
		const units = lines[gi + 2] ?? ''
		expect(units).toBe(`   ${'0123456789012345'}`) // 2-wide gutter + 1 space, then col units
		expect(tens.endsWith('111111')).toBe(true) // tens digit only past column 9
		expect(tens.length).toBe(units.length)
		expect(lines[gi + 3]?.startsWith(' 0 ')).toBe(true)
		expect(lines[gi + 18]?.startsWith('15 ')).toBe(true)
	})

	it('omits the tens line for a narrow canvas', async () => {
		const out = await show(blank(8), true)
		const lines = out.split('\n')
		const gi = lines.indexOf('grid')
		expect(lines[gi + 1]).toBe('  01234567') // straight to units (w=8 ≤ 10)
	})
})

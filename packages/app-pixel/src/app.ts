import { defineApp } from '@justfiles/app'
import * as v from 'valibot'
import {
	clear as clearGrid,
	fillRect as fillRectGrid,
	floodFill as floodFillGrid,
	drawLine as lineGrid,
	drawRect as rectGrid,
	resizeGrid,
	setPixels as setPixelsGrid
} from './bitmap.ts'
import { MAX_COLORS, MAX_SIZE, newDoc, type PixelDoc } from './doc.ts'

// The six-tool set; `tool` is a persisted pointer so the GUI and the agent share
// one active tool. Drawing itself flows through the batch actions below, so the
// agent never needs a tool selected — it names the shape it wants directly.
export type Tool = 'pencil' | 'eraser' | 'fill' | 'eyedropper' | 'line' | 'rect'

// The whole editor state. `doc` is the artwork (in state, so the agent reads it);
// `tool`/`colorIndex` are the active selection. `lastSavedPath`/`lastError` are
// reserved for phase 4 (PNG export) — kept here so the shape is stable.
export type PixelState = {
	doc: PixelDoc
	// Added in phase 2. Persisted phase-1 state is `{ doc }` only and the kernel
	// rehydrates it verbatim (no merge with `init`), so tolerate their absence and
	// default at the GUI read site.
	tool?: Tool
	colorIndex?: number
	lastSavedPath: string | null
	lastError: string | null
}

// A 16×16 red heart in the DB16 palette, so a fresh install renders something
// crisp and the palette-swap superpower is demonstrable on real pixels.
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

export const initialState: PixelState = {
	doc: { ...newDoc(16), grid: HEART },
	tool: 'pencil',
	colorIndex: 7,
	lastSavedPath: null,
	lastError: null
}

// Tight schemas — the agent fills each from its `schemaHint`, so invalid input is
// impossible. Coordinates and spans are bounded to the canvas cap so a rasterizer
// can never iterate an unbounded (or precision-losing) range and pin the reducer
// worker; the pure primitives still clip individual writes to the live grid.
const coord = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_SIZE - 1))
const rectSpan = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_SIZE))
const idx = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_COLORS))
const paletteIdx = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_COLORS))
const dim = v.pipe(v.number(), v.integer(), v.minValue(1))
const color = v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/))
const tool = v.picklist(['pencil', 'eraser', 'fill', 'eyedropper', 'line', 'rect'] as const)
const pixel = v.object({ x: coord, y: coord, i: idx })

const withGrid = (state: PixelState, grid: string[]): PixelState => ({
	...state,
	doc: { ...state.doc, grid }
})

export const app = defineApp({
	init: initialState,
	update: (t) => ({
		// Drawing — batch-first so the agent (and a committed human stroke) places
		// many pixels per dispatch, keeping the /state write count low.
		setPixels: t.on(
			v.object({ pixels: v.array(pixel) }),
			(s, { pixels }) => withGrid(s, setPixelsGrid(s.doc.grid, pixels)),
			{
				description:
					'Place many pixels at once; each is {x,y,i} where i is a palette index (0 = transparent). The batch workhorse — also backs a committed freehand stroke.',
				examples: [
					{
						params: {
							pixels: [
								{ x: 0, y: 0, i: 1 },
								{ x: 1, y: 0, i: 1 }
							]
						}
					}
				]
			}
		),
		drawLine: t.on(
			v.object({ x0: coord, y0: coord, x1: coord, y1: coord, i: idx }),
			(s, { x0, y0, x1, y1, i }) => withGrid(s, lineGrid(s.doc.grid, x0, y0, x1, y1, i)),
			{
				description: 'Draw a 1px Bresenham line from (x0,y0) to (x1,y1) in palette index i.',
				examples: [{ params: { x0: 0, y0: 0, x1: 5, y1: 5, i: 1 } }]
			}
		),
		fillRect: t.on(
			v.object({ x: coord, y: coord, w: rectSpan, h: rectSpan, i: idx }),
			(s, { x, y, w, h, i }) => withGrid(s, fillRectGrid(s.doc.grid, x, y, w, h, i)),
			{
				description: 'Fill a solid w×h rectangle with top-left (x,y) in palette index i.',
				examples: [{ params: { x: 2, y: 2, w: 4, h: 3, i: 1 } }]
			}
		),
		drawRect: t.on(
			v.object({ x: coord, y: coord, w: rectSpan, h: rectSpan, i: idx }),
			(s, { x, y, w, h, i }) => withGrid(s, rectGrid(s.doc.grid, x, y, w, h, i)),
			{
				description: 'Draw the outline of a w×h rectangle with top-left (x,y) in palette index i.',
				examples: [{ params: { x: 1, y: 1, w: 6, h: 6, i: 1 } }]
			}
		),
		floodFill: t.on(
			v.object({ x: coord, y: coord, i: idx }),
			(s, { x, y, i }) => withGrid(s, floodFillGrid(s.doc.grid, x, y, i)),
			{
				description:
					'Flood-fill the contiguous region of like-coloured pixels at (x,y) with palette index i. Deterministic; order-dependent on current pixels.',
				examples: [{ params: { x: 8, y: 8, i: 2 } }]
			}
		),
		clear: t.on(v.object({}), (s) => withGrid(s, clearGrid(s.doc.grid)), {
			description: 'Clear the whole canvas to transparent.',
			examples: [{ params: {} }]
		}),
		// Colour / palette.
		setColorIndex: t.on(
			v.object({ i: idx }),
			// Clamp to a colour that actually exists so the active index can never point
			// past the palette (which would draw invisibly).
			(s, { i }) => ({ ...s, colorIndex: Math.min(i, s.doc.palette.length) }),
			{
				description:
					'Set the active palette index (0 = transparent/erase; clamped to the palette). The GUI draws with it; the agent passes i per action instead.',
				examples: [{ params: { i: 6 } }]
			}
		),
		setPaletteColor: t.on(
			v.object({ i: paletteIdx, color }),
			(s, { i, color }) => {
				const { palette } = s.doc
				if (i > palette.length + 1) return s // only replace an entry or append the next one
				const next = palette.slice()
				next[i - 1] = color
				return { ...s, doc: { ...s.doc, palette: next } }
			},
			{
				description:
					'Set palette entry i (1-based) to a #rrggbb colour — recolours every pixel drawn with i at once. i = palette length + 1 appends a new colour.',
				examples: [{ params: { i: 7, color: '#d04648' } }]
			}
		),
		setPalette: t.on(
			v.object({ palette: v.pipe(v.array(color), v.minLength(1), v.maxLength(MAX_COLORS)) }),
			(s, { palette }) => ({
				...s,
				colorIndex: Math.min(s.colorIndex ?? 0, palette.length),
				doc: { ...s.doc, palette }
			}),
			{
				description:
					'Replace the whole palette (#rrggbb list, index 1..N) — an instant global recolour to a new scheme without touching a pixel. Give at least as many entries as the sprite uses, or higher-index pixels render as nothing.',
				// A full 16-entry swap (DB16 → PICO-8) so it recolours the default heart
				// (index 7) instead of dropping it.
				examples: [
					{
						params: {
							palette: [
								'#000000',
								'#1d2b53',
								'#7e2553',
								'#008751',
								'#ab5236',
								'#5f574f',
								'#c2c3c7',
								'#fff1e8',
								'#ff004d',
								'#ffa300',
								'#ffec27',
								'#00e436',
								'#29adff',
								'#83769c',
								'#ff77a8',
								'#ffccaa'
							]
						}
					}
				]
			}
		),
		// Canvas.
		resize: t.on(
			v.object({ width: dim, height: dim }),
			(s, { width, height }) => {
				const w = Math.min(MAX_SIZE, width)
				const h = Math.min(MAX_SIZE, height)
				return { ...s, doc: { ...s.doc, width: w, height: h, grid: resizeGrid(s.doc.grid, w, h) } }
			},
			{
				description:
					'Resize the canvas (clamped to ≤64). Destructive: pixels outside the new bounds are cropped.',
				examples: [{ params: { width: 32, height: 32 } }]
			}
		),
		setTool: t.on(v.object({ tool }), (s, { tool }) => ({ ...s, tool }), {
			description: 'Pick the active tool: pencil | eraser | fill | eyedropper | line | rect.',
			examples: [{ params: { tool: 'pencil' } }]
		})
	})
})

export type PixelApp = typeof app

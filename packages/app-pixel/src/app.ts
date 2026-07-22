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
import {
	CHARS,
	charToIndex,
	decode,
	encodeText,
	MAX_COLORS,
	MAX_SIZE,
	newDoc,
	type PixelDoc,
	TRANSPARENT
} from './doc.ts'

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
// A piped char-grid for `setGrid`: bounded so a hand-written blob can never grow
// past a full 64×64 canvas plus its palette legend and headers.
const gridText = v.pipe(v.string(), v.maxLength(16384))

const withGrid = (state: PixelState, grid: string[]): PixelState => ({
	...state,
	doc: { ...state.doc, grid }
})

// If the piped text is a whole `.pixel` document, return its declared version so
// `setGrid` can replace the canvas via `decode` (and reject an unsupported one);
// otherwise null, so the text is stamped as a patch — e.g. an edited `show` dump
// pasted back. "Whole document" means the structure `decode` keys off: the `pixel
// <version>` magic as the first meaningful line, plus a `grid` section (the `size`
// header is optional — decode derives w/h from the grid when it is absent). That
// structure requirement is why a hand-drawn patch whose first row spells
// `pixel`/`pixel 1` (legal cell data) returns null here rather than tripping a
// canvas-wiping replace.
const fullDocVersion = (text: string): number | null => {
	let version: number | null = null
	let grid = false
	let first = true
	for (const raw of text.split(/\r?\n/)) {
		const t = raw.trim()
		if (t === '' || t.startsWith('#')) continue
		if (first) {
			first = false
			const m = /^pixel\s+(\d+)(\s|$)/.exec(t)
			if (!m) return null
			version = Number(m[1])
			continue
		}
		if (t === 'grid') grid = true
	}
	return grid ? version : null
}

// Parse a stamped patch into the {x,y,i} the batch `setPixels` replays, offset to
// (ox,oy). Per cell: a base62 char or '.' draws (charToIndex maps '.'→0/erase); a
// SPACE leaves the existing pixel untouched (skip); anything else is skipped too.
// Blank lines and '# comment' lines are ignored (they don't advance the row), so
// only content rows consume a y — short rows just skip their missing right cells.
const patchPixels = (
	text: string,
	ox: number,
	oy: number
): { x: number; y: number; i: number }[] => {
	const pixels: { x: number; y: number; i: number }[] = []
	let r = 0
	for (const line of text.split(/\r?\n/)) {
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue
		for (let c = 0; c < line.length; c++) {
			const ch = line[c]
			if (ch === undefined || ch === ' ') continue
			if (ch === TRANSPARENT || CHARS.includes(ch))
				pixels.push({ x: ox + c, y: oy + r, i: charToIndex(ch) })
		}
		r++
	}
	return pixels
}

// Overlay 0-based column/row numbers on a `.pixel` dump (display only, for the
// agent to target x,y). Row indices go in a left gutter; a tens line appears only
// past column 9. The annotated grid is NOT parseable — never pipe it back.
const rulerize = (text: string, w: number, h: number): string => {
	const lines = text.split('\n')
	const gi = lines.indexOf('grid')
	if (gi === -1) return text
	const g = String(Math.max(0, h - 1)).length
	const pad = ' '.repeat(g + 1)
	const col = (pick: (x: number) => string) =>
		pad + Array.from({ length: w }, (_, x) => pick(x)).join('')
	const header = [
		...lines.slice(0, gi + 1),
		...(w > 10 ? [col((x) => (x < 10 ? ' ' : String(Math.floor(x / 10) % 10)))] : []),
		col((x) => String(x % 10))
	]
	const rows = lines.slice(gi + 1, gi + 1 + h).map((row, y) => `${String(y).padStart(g)} ${row}`)
	return [...header, ...rows, ...lines.slice(gi + 1 + h)].join('\n')
}

export const app = defineApp({
	init: initialState,
	update: (t) => ({
		// Drawing — batch-first so the agent (and a committed human stroke) places
		// many pixels per dispatch, keeping the /state write count low.
		setPixels: t.on(
			v.object({ pixels: v.pipe(v.array(pixel), v.maxLength(MAX_SIZE * MAX_SIZE)) }),
			(s, { pixels }) => withGrid(s, setPixelsGrid(s.doc.grid, pixels)),
			{
				// The primary agent tool + the read↔write bridge, so this description carries the
				// coordinate + char-encoding contract the rest of the surface relies on.
				description:
					'Place many pixels in one dispatch — the batch workhorse, so build a whole shape per call. Each item is {x,y,i}: x is the column and y the row, both 0-based from the top-left (0,0); i is a palette index (0 = transparent/erase, 1..N picks palette[i-1]). To match a colour you see in state.doc.grid, note it is one char per pixel — "." is transparent and "0"-"9","a"-"z","A"-"Z" are palette indices 1..62 in order.',
				// A 5-pixel plus sign, so the example itself reads as "several cells at once".
				examples: [
					{
						params: {
							pixels: [
								{ x: 2, y: 1, i: 1 },
								{ x: 1, y: 2, i: 1 },
								{ x: 2, y: 2, i: 1 },
								{ x: 3, y: 2, i: 1 },
								{ x: 2, y: 3, i: 1 }
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
				description:
					'Draw a 1px line between (x0,y0) and (x1,y1) in palette index i (0 = transparent). Coordinates are 0-based from the top-left; both endpoints are inclusive.',
				examples: [{ params: { x0: 0, y0: 0, x1: 5, y1: 5, i: 1 } }]
			}
		),
		fillRect: t.on(
			v.object({ x: coord, y: coord, w: rectSpan, h: rectSpan, i: idx }),
			(s, { x, y, w, h, i }) => withGrid(s, fillRectGrid(s.doc.grid, x, y, w, h, i)),
			{
				description:
					'Fill a solid w×h rectangle whose top-left corner is (x,y) with palette index i (0 = transparent). Good for backgrounds and blocks in one dispatch.',
				examples: [{ params: { x: 2, y: 2, w: 4, h: 3, i: 1 } }]
			}
		),
		drawRect: t.on(
			v.object({ x: coord, y: coord, w: rectSpan, h: rectSpan, i: idx }),
			(s, { x, y, w, h, i }) => withGrid(s, rectGrid(s.doc.grid, x, y, w, h, i)),
			{
				description:
					'Draw only the 1px outline of a w×h rectangle whose top-left corner is (x,y) in palette index i (interior left untouched).',
				examples: [{ params: { x: 1, y: 1, w: 6, h: 6, i: 1 } }]
			}
		),
		floodFill: t.on(
			v.object({ x: coord, y: coord, i: idx }),
			(s, { x, y, i }) => withGrid(s, floodFillGrid(s.doc.grid, x, y, i)),
			{
				description:
					'Flood-fill the contiguous same-coloured region touching (x,y) with palette index i, like a paint bucket. Deterministic; depends on the current pixels.',
				examples: [{ params: { x: 8, y: 8, i: 2 } }]
			}
		),
		clear: t.on(v.object({}), (s) => withGrid(s, clearGrid(s.doc.grid)), {
			description: 'Erase the whole canvas to transparent (every pixel back to index 0).',
			examples: [{ params: {} }]
		}),
		// Draw from a char grid piped in via stdin — the ASCII-art path, the write
		// half of the `show` read format. Route the whole doc through `decode` when
		// it's a full `.pixel` dump; otherwise stamp the rows as a patch.
		setGrid: t.on(
			v.object({ grid: gridText, x: v.optional(coord), y: v.optional(coord) }),
			(s, { grid, x, y }) => {
				const version = fullDocVersion(grid)
				if (version !== null) {
					// A full `.pixel` dump replaces the canvas — but only a version this build
					// understands. Reject an unsupported version instead of letting `decode`
					// silently fall back to a blank default and wipe the artwork.
					if (version !== 1)
						throw new Error(
							`setGrid: unsupported .pixel version ${version} (this build reads version 1).`
						)
					const doc = decode(new TextEncoder().encode(grid))
					return { ...s, colorIndex: Math.min(s.colorIndex ?? 0, doc.palette.length), doc }
				}
				return withGrid(s, setPixelsGrid(s.doc.grid, patchPixels(grid, x ?? 0, y ?? 0)))
			},
			{
				description:
					"Draw by piping a character grid — sketch the picture as ASCII rows and pipe it into the `grid` param via stdin: `app run --id <id> setGrid --stdin grid <<'EOF' … EOF` (or `printf ... | app run … setGrid --stdin grid`). It's the same char-per-pixel format you read in `show`/state.doc.grid. Per cell: '0'-'9','a'-'z','A'-'Z' set that palette index (1..62); '.' sets transparent (erases the cell); a SPACE leaves the existing pixel untouched (skip); blank lines and '# comment' lines are ignored. Pass x,y to stamp the grid with that top-left origin (default 0,0) and edit a small region without redrawing the whole canvas — the patch is clipped to the canvas, and short rows skip their missing right-hand cells. If the piped text is a full .pixel document (its first line is `pixel <version>`), it REPLACES the whole canvas and palette instead (x,y ignored) — e.g. paste back an edited `show` dump. A single row with no spaces can also go inline as grid=<row>.",
				// One 2-row patch stamped at (6,8): no spaces/newlines, so it also shows the
				// runnable inline form; the multi-line heredoc form is in the description.
				examples: [{ params: { grid: '.66.', x: 6, y: 8 } }]
			}
		),
		// Colour / palette.
		setColorIndex: t.on(
			v.object({ i: idx }),
			// Clamp to a colour that actually exists so the active index can never point
			// past the palette (which would draw invisibly).
			(s, { i }) => ({ ...s, colorIndex: Math.min(i, s.doc.palette.length) }),
			{
				description:
					"Set the GUI's active palette index (0 = transparent/erase; clamped to the palette). The agent normally passes i per draw action instead of setting this.",
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
					'Recolour one palette entry: set entry i (1-based) to a #rrggbb colour, instantly updating every pixel drawn with i — zero pixel edits. Pass i = current palette length + 1 to append a new colour.',
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
					"Swap the whole palette (list of #rrggbb, index 1..N) for an instant global recolour — e.g. to a night scheme — without touching a pixel. Provide at least as many colours as the artwork's highest index, or those pixels render as nothing.",
				// A ready-to-use 16-entry night palette (cool dark blues → moonlit highlights),
				// same length as the DB16 default so it recolours the starter heart (index 7)
				// instead of dropping it — the exact "recolour to a night palette" move.
				examples: [
					{
						params: {
							palette: [
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
					'Resize the canvas to width×height (clamped to ≤64). Destructive: pixels outside the new bounds are cropped, and pixels kept stay at the same (x,y).',
				examples: [{ params: { width: 32, height: 32 } }]
			}
		),
		setTool: t.on(v.object({ tool }), (s, { tool }) => ({ ...s, tool }), {
			description:
				"Select the GUI's active tool: pencil | eraser | fill | eyedropper | line | rect. The agent normally draws via the batch actions instead.",
			examples: [{ params: { tool: 'pencil' } }]
		})
	}),
	procedures: (p) => ({
		// The agent's canvas view: the same `.pixel` text `setGrid` accepts, so the
		// read/write formats match. Pure read — only touches `app.state`.
		show: p.procedure({
			description:
				'Show the canvas as .pixel text — the palette legend plus the char grid, exactly the format setGrid accepts, so you can read it, edit it, and pipe it back (run with --raw to emit the raw text for a pipe: `app run --id <id> show --raw | app run --id <id> setGrid --stdin grid`). Your best way to SEE the current picture (more digestible than raw state). Pass ruler=true to overlay 0-based column/row numbers so you can target x,y for a setGrid patch — the ruler view is for READING only; never pipe it back into setGrid. Default: no ruler.',
			schema: v.object({ ruler: v.optional(v.boolean()) }),
			run({ ruler }, app) {
				const { doc } = app.state
				const text = encodeText(doc)
				return ruler ? rulerize(text, doc.width, doc.height) : text
			}
		})
	})
})

export type PixelApp = typeof app

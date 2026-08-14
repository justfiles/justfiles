// The encoding boundary mirrors Paint: the pixel grid
// is stored as one character per pixel so it is both compact in /state and
// directly legible to an LLM agent (it reads the picture as ASCII art).

export type PixelDoc = {
	type: 'justfiles/pixel'
	version: 1
	width: number // ≤ 64
	height: number // ≤ 64
	palette: string[] // opaque colours '#rrggbb'; palette[k] ↔ pixel index k+1
	grid: string[] // `height` rows, each `width` chars; 1 char per pixel
}

const DOC_TYPE = 'justfiles/pixel'

// Canvas is bounded and small — this is the whole reason pixel data can live in
// state. Square sizes only; 64×64 (~4.3 KB of grid) is the hard cap.
export type Size = 16 | 32 | 64
export const SIZES: Size[] = [16, 32, 64]
export const MAX_SIZE = 64

// Char encoding: '.' = transparent (index 0); base62 `0-9 a-z A-Z` index into
// palette[1..62]. CHARS[k] ↔ pixel index k+1 ↔ palette[k].
export const TRANSPARENT = '.'
export const CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const MAX_COLORS = CHARS.length // 62

// Index 0 = transparent; 1..62 = a palette entry. Out-of-range collapses to
// transparent so a corrupt cell never throws.
export function indexToChar(i: number): string {
	return i >= 1 && i <= MAX_COLORS ? (CHARS[i - 1] ?? TRANSPARENT) : TRANSPARENT
}

export function charToIndex(ch: string): number {
	if (ch === TRANSPARENT) return 0
	const k = CHARS.indexOf(ch)
	return k < 0 ? 0 : k + 1
}

// Read a pixel index off the grid; out-of-bounds reads as transparent.
export function getPixel(grid: string[], x: number, y: number): number {
	const row = grid[y]
	if (!row || x < 0 || x >= row.length) return 0
	return charToIndex(row[x] ?? TRANSPARENT)
}

// DawnBringer 16 — the editable, growable default palette (indices 1..16).
export const DB16 = [
	'#140c1c',
	'#442434',
	'#30346d',
	'#4e4a4e',
	'#854c30',
	'#346524',
	'#d04648',
	'#757161',
	'#597dce',
	'#d27d2c',
	'#8595a1',
	'#6daa2c',
	'#d2aa99',
	'#6dc2ca',
	'#dad45e',
	'#deeed6'
]

export function newDoc(size: Size = 32): PixelDoc {
	const n = Math.min(size, MAX_SIZE)
	const row = TRANSPARENT.repeat(n)
	return {
		type: DOC_TYPE,
		version: 1,
		width: n,
		height: n,
		palette: [...DB16],
		grid: Array.from({ length: n }, () => row)
	}
}

// The only serialization boundary — a line-oriented text format (XPM's char-grid
// legend inside PICO-8's section grammar) rather than JSON, so a `.pixel` file
// reads as a picture and an agent can hand-write one with zero quoting:
//
//   pixel 1                 magic + version (drives migration)
//   size 16 16              width height (both clamped to MAX_SIZE)
//   palette                 legend: one `<char> #rrggbb` per line, char = the
//   0 #140c1c               exact grid char (no base62 offset math on disk)
//   6 #d04648               ('.' is transparent and never listed)
//   grid                    exactly `height` rows of `width` chars follow
//   ................
//   ..666......666..
//   ...
//
// `# comment` lines and blank lines are ignored anywhere. The parser dispatches
// on the leading keyword and ignores unknown ones (forward-tolerant, so future
// `layer`/`frame` sections don't break v1). A malformed blob or unknown version
// falls back to a fresh doc, exactly like the old JSON path.
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

const clampSize = (n: number): number => Math.max(1, Math.min(MAX_SIZE, Math.floor(n) || 1))

const padRow = (row: string, w: number): string =>
	row.length >= w ? row.slice(0, w) : row + TRANSPARENT.repeat(w - row.length)

// The `.pixel` text form (see `decode` for the grammar). Exposed for the app's
// `show` action, which returns the same artifact the agent pipes into `setGrid`
// — read-format == write-format == file-format.
export function encodeText(doc: PixelDoc): string {
	const palette = doc.palette ?? []
	const grid = doc.grid ?? []
	return `${[
		`pixel ${doc.version}`,
		`size ${doc.width} ${doc.height}`,
		'palette',
		...palette.map((color, k) => `${indexToChar(k + 1)} ${color}`),
		'grid',
		...grid
	].join('\n')}\n`
}

export function encode(doc: PixelDoc): Uint8Array {
	return new TextEncoder().encode(encodeText(doc))
}

export function decode(bytes: Uint8Array): PixelDoc {
	try {
		const lines = new TextDecoder().decode(bytes).split(/\r?\n/)
		let version = 0
		let width = 0
		let height = 0
		const paletteByIndex = new Map<number, string>()
		const grid: string[] = []
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]?.trim() ?? ''
			if (line === '' || line.startsWith('#')) continue
			const parts = line.split(/\s+/)
			const kw = parts[0]
			if (kw === 'pixel') {
				version = Number(parts[1])
			} else if (kw === 'size') {
				width = Number(parts[1])
				height = Number(parts[2])
			} else if (kw === 'palette') {
				// Legend runs until a line that isn't `<base62 char> #rrggbb`.
				while (i + 1 < lines.length) {
					const l = lines[i + 1]?.trim() ?? ''
					if (l === '' || l.startsWith('#')) {
						i++
						continue
					}
					const p = l.split(/\s+/)
					const ch = p[0]
					const col = p[1]
					if (
						p.length === 2 &&
						ch !== undefined &&
						col !== undefined &&
						CHARS.includes(ch) &&
						COLOR_RE.test(col)
					) {
						paletteByIndex.set(charToIndex(ch), col)
						i++
					} else break
				}
			} else if (kw === 'grid') {
				// Rows are read by count (size tells us how many), so a row that happens
				// to spell a keyword can't be mistaken for one. Height unknown → read on.
				while (i + 1 < lines.length && grid.length < (height || lines.length)) {
					const raw = lines[i + 1]?.trim() ?? ''
					i++
					if (raw === '' || raw.startsWith('#')) continue
					grid.push(raw)
				}
			}
			// unknown keyword → ignored (forward-tolerant)
		}
		if (version !== 1) return newDoc()
		const w = clampSize(width || grid.reduce((m, r) => Math.max(m, r.length), 0))
		const h = clampSize(height || grid.length)
		let maxIndex = 0
		for (const k of paletteByIndex.keys()) if (k > maxIndex) maxIndex = k
		const palette =
			maxIndex > 0
				? Array.from({ length: maxIndex }, (_, k) => paletteByIndex.get(k + 1) ?? '#000000')
				: [...DB16]
		return {
			type: DOC_TYPE,
			version: 1,
			width: w,
			height: h,
			palette,
			grid: Array.from({ length: h }, (_, y) => padRow(grid[y] ?? '', w))
		}
	} catch {
		// fall through to a fresh doc
	}
	return newDoc()
}

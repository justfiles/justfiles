// The encoding boundary (mirrors packages/app-paint/src/doc.ts): the pixel grid
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

// The only serialization boundary. JSON now (cat-able while debugging); the
// `version` envelope means a future format change is a one-file swap and no call
// site knows the wire format. A malformed blob falls back to a fresh doc.
export function encode(doc: PixelDoc): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(doc))
}

export function decode(bytes: Uint8Array): PixelDoc {
	try {
		const doc = JSON.parse(new TextDecoder().decode(bytes)) as PixelDoc
		if (
			doc?.type === DOC_TYPE &&
			doc.version === 1 &&
			Array.isArray(doc.grid) &&
			Array.isArray(doc.palette)
		)
			return doc
	} catch {
		// fall through to a fresh doc
	}
	return newDoc()
}

import { drawEllipse, drawRect, fill, floodFill, stampLine, stampPoint } from './bitmap.ts'

export const CANVAS_W = 800
export const CANVAS_H = 600
export const BACKGROUND = '#ffffff'

export type Size = 1 | 3 | 5

// An ordered operation. The canvas is a pure function of replaying ops in order
// with smoothing off — byte-for-byte the immediate-mode look, reusing bitmap.ts.
// `id` is kept per op for deferred selection + co-op (no format break later).
export type Op =
	| {
			id: string
			kind: 'stroke'
			tool: 'pencil' | 'eraser'
			size: Size
			color: string
			points: number[]
	  } // flat [x0,y0,x1,y1,…], integer px
	| {
			id: string
			kind: 'line'
			size: Size
			color: string
			x0: number
			y0: number
			x1: number
			y1: number
	  }
	| {
			id: string
			kind: 'rect'
			size: Size
			color: string
			x0: number
			y0: number
			x1: number
			y1: number
	  }
	| {
			id: string
			kind: 'ellipse'
			size: Size
			color: string
			x0: number
			y0: number
			x1: number
			y1: number
	  }
	| { id: string; kind: 'fill'; color: string; x: number; y: number }
	| { id: string; kind: 'clear'; color: string }

export type PaintDoc = {
	type: 'justfiles/paint'
	version: 1
	width: number
	height: number
	background: string
	ops: Op[]
}

const DOC_TYPE = 'justfiles/paint'

export function newDoc(): PaintDoc {
	return {
		type: DOC_TYPE,
		version: 1,
		width: CANVAS_W,
		height: CANVAS_H,
		background: BACKGROUND,
		ops: []
	}
}

export function newId(): string {
	return crypto.randomUUID()
}

// Draw one op onto ctx (caller has smoothing off). Used by both replay and the
// live draw path, so they stay byte-identical.
export function drawOp(ctx: CanvasRenderingContext2D, op: Op) {
	switch (op.kind) {
		case 'stroke': {
			const p = op.points
			if (p.length <= 2) {
				stampPoint(ctx, p[0] ?? 0, p[1] ?? 0, op.size, op.color)
				return
			}
			for (let i = 2; i < p.length; i += 2)
				stampLine(ctx, p[i - 2] ?? 0, p[i - 1] ?? 0, p[i] ?? 0, p[i + 1] ?? 0, op.size, op.color)
			return
		}
		case 'line':
			stampLine(ctx, op.x0, op.y0, op.x1, op.y1, op.size, op.color)
			return
		case 'rect':
			drawRect(ctx, op.x0, op.y0, op.x1, op.y1, op.size, op.color)
			return
		case 'ellipse':
			drawEllipse(ctx, op.x0, op.y0, op.x1, op.y1, op.size, op.color)
			return
		case 'fill':
			floodFill(ctx, op.x, op.y, op.color)
			return
		case 'clear':
			fill(ctx, op.color)
			return
	}
}

// The canvas is `background` then every op in order.
export function replay(ctx: CanvasRenderingContext2D, doc: PaintDoc) {
	fill(ctx, doc.background)
	for (const op of doc.ops) drawOp(ctx, op)
}

// The only serialization boundary. JSON now (cat-able while debugging); the
// `version` envelope means a future binary format is a one-file change and no
// call site knows the wire format.
export function encode(doc: PaintDoc): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(doc))
}

export function decode(bytes: Uint8Array): PaintDoc {
	try {
		const doc = JSON.parse(new TextDecoder().decode(bytes)) as PaintDoc
		if (doc?.type === DOC_TYPE && doc.version === 1 && Array.isArray(doc.ops)) return doc
	} catch {
		// fall through to a fresh doc
	}
	return newDoc()
}

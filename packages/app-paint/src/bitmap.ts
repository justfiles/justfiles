export type Rgba = { r: number; g: number; b: number; a: number }

export function hexToRgba(hex: string): Rgba {
	const v = hex.replace('#', '')
	const r = parseInt(v.slice(0, 2), 16)
	const g = parseInt(v.slice(2, 4), 16)
	const b = parseInt(v.slice(4, 6), 16)
	return { r, g, b, a: 255 }
}

function stamp(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
	const o = Math.floor(size / 2)
	ctx.fillRect(Math.round(x) - o, Math.round(y) - o, size, size)
}

export function stampPoint(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	size: number,
	color: string
) {
	ctx.fillStyle = color
	stamp(ctx, x, y, size)
}

export function stampLine(
	ctx: CanvasRenderingContext2D,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	size: number,
	color: string
) {
	ctx.fillStyle = color
	let ax = Math.round(x0)
	let ay = Math.round(y0)
	const bx = Math.round(x1)
	const by = Math.round(y1)
	const dx = Math.abs(bx - ax)
	const dy = -Math.abs(by - ay)
	const sx = ax < bx ? 1 : -1
	const sy = ay < by ? 1 : -1
	let err = dx + dy
	for (;;) {
		stamp(ctx, ax, ay, size)
		if (ax === bx && ay === by) break
		const e2 = 2 * err
		if (e2 >= dy) {
			err += dy
			ax += sx
		}
		if (e2 <= dx) {
			err += dx
			ay += sy
		}
	}
}

export function drawRect(
	ctx: CanvasRenderingContext2D,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	size: number,
	color: string
) {
	stampLine(ctx, x0, y0, x1, y0, size, color)
	stampLine(ctx, x1, y0, x1, y1, size, color)
	stampLine(ctx, x1, y1, x0, y1, size, color)
	stampLine(ctx, x0, y1, x0, y0, size, color)
}

export function drawEllipse(
	ctx: CanvasRenderingContext2D,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	size: number,
	color: string
) {
	const cx = (x0 + x1) / 2
	const cy = (y0 + y1) / 2
	const rx = Math.abs(x1 - x0) / 2
	const ry = Math.abs(y1 - y0) / 2
	if (rx < 0.5 && ry < 0.5) {
		stampPoint(ctx, cx, cy, size, color)
		return
	}
	const steps = Math.max(16, Math.ceil(2 * Math.PI * Math.max(rx, ry)))
	let prevX = cx + rx
	let prevY = cy
	for (let i = 1; i <= steps; i++) {
		const t = (i / steps) * 2 * Math.PI
		const x = cx + rx * Math.cos(t)
		const y = cy + ry * Math.sin(t)
		stampLine(ctx, prevX, prevY, x, y, size, color)
		prevX = x
		prevY = y
	}
}

export function floodFill(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
	const w = ctx.canvas.width
	const h = ctx.canvas.height
	const sx = Math.round(x)
	const sy = Math.round(y)
	if (sx < 0 || sx >= w || sy < 0 || sy >= h) return
	const img = ctx.getImageData(0, 0, w, h)
	const data = img.data
	const targetIdx = (sy * w + sx) * 4
	const tr = data[targetIdx]
	const tg = data[targetIdx + 1]
	const tb = data[targetIdx + 2]
	const ta = data[targetIdx + 3]
	const repl = hexToRgba(color)
	if (tr === repl.r && tg === repl.g && tb === repl.b && ta === repl.a) return

	const stack: number[] = [sx, sy]
	while (stack.length > 0) {
		const py0 = stack.pop() as number
		const px = stack.pop() as number
		let py = py0
		while (py >= 0 && matches(data, (py * w + px) * 4, tr, tg, tb, ta)) py--
		py++
		let spanLeft = false
		let spanRight = false
		while (py < h && matches(data, (py * w + px) * 4, tr, tg, tb, ta)) {
			const i = (py * w + px) * 4
			data[i] = repl.r
			data[i + 1] = repl.g
			data[i + 2] = repl.b
			data[i + 3] = repl.a
			if (px > 0) {
				const leftSame = matches(data, (py * w + px - 1) * 4, tr, tg, tb, ta)
				if (!spanLeft && leftSame) {
					stack.push(px - 1, py)
					spanLeft = true
				} else if (spanLeft && !leftSame) {
					spanLeft = false
				}
			}
			if (px < w - 1) {
				const rightSame = matches(data, (py * w + px + 1) * 4, tr, tg, tb, ta)
				if (!spanRight && rightSame) {
					stack.push(px + 1, py)
					spanRight = true
				} else if (spanRight && !rightSame) {
					spanRight = false
				}
			}
			py++
		}
	}
	ctx.putImageData(img, 0, 0)
}

function matches(
	data: Uint8ClampedArray,
	i: number,
	r: number | undefined,
	g: number | undefined,
	b: number | undefined,
	a: number | undefined
): boolean {
	return data[i] === r && data[i + 1] === g && data[i + 2] === b && data[i + 3] === a
}

export function snapshot(ctx: CanvasRenderingContext2D): ImageData {
	return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height)
}

export function restore(ctx: CanvasRenderingContext2D, img: ImageData) {
	ctx.putImageData(img, 0, 0)
}

export function fill(ctx: CanvasRenderingContext2D, color: string) {
	ctx.fillStyle = color
	ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
}

export async function canvasToPngBase64(canvas: HTMLCanvasElement): Promise<string> {
	const blob: Blob = await new Promise((resolve, reject) => {
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png')
	})
	const buf = await blob.arrayBuffer()
	const bytes = new Uint8Array(buf)
	let binary = ''
	const chunk = 0x8000
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
	}
	return btoa(binary)
}

type Matrix = [number, number, number, number, number, number]
type Color = [number, number, number, number]

// The built-in avatar only needs solid rectangles and transforms. This small Canvas subset
// keeps still-image rendering deterministic and browser-free.
export class RasterContext {
	readonly canvas: { width: number; height: number }
	readonly pixels: Uint8Array
	fillStyle = '#000000'
	globalAlpha = 1
	imageSmoothingEnabled = false
	private matrix: Matrix = [1, 0, 0, 1, 0, 0]
	private readonly stack: { matrix: Matrix; alpha: number; fill: string }[] = []

	constructor(width: number, height: number) {
		this.canvas = { width, height }
		this.pixels = new Uint8Array(width * height * 4)
	}

	clearRect(x: number, y: number, width: number, height: number): void {
		this.walk(x, y, width, height, (index) => this.pixels.fill(0, index, index + 4))
	}

	fillRect(x: number, y: number, width: number, height: number): void {
		const color = parseColor(this.fillStyle)
		const alpha = color[3] * this.globalAlpha
		this.walk(x, y, width, height, (index) => blend(this.pixels, index, color, alpha))
	}

	save(): void {
		this.stack.push({ matrix: [...this.matrix], alpha: this.globalAlpha, fill: this.fillStyle })
	}

	restore(): void {
		const state = this.stack.pop()
		if (!state) return
		this.matrix = state.matrix
		this.globalAlpha = state.alpha
		this.fillStyle = state.fill
	}

	translate(x: number, y: number): void {
		const [a, b, c, d, e, f] = this.matrix
		this.matrix = [a, b, c, d, e + a * x + c * y, f + b * x + d * y]
	}

	rotate(angle: number): void {
		const [a, b, c, d, e, f] = this.matrix
		const cosine = Math.cos(angle)
		const sine = Math.sin(angle)
		this.matrix = [
			a * cosine + c * sine,
			b * cosine + d * sine,
			c * cosine - a * sine,
			d * cosine - b * sine,
			e,
			f
		]
	}

	scale(x: number, y: number): void {
		const [a, b, c, d, e, f] = this.matrix
		this.matrix = [a * x, b * x, c * y, d * y, e, f]
	}

	private walk(
		x: number,
		y: number,
		width: number,
		height: number,
		visit: (index: number) => void
	): void {
		const [a, b, c, d, e, f] = this.matrix
		const corners = [
			transform(x, y, this.matrix),
			transform(x + width, y, this.matrix),
			transform(x, y + height, this.matrix),
			transform(x + width, y + height, this.matrix)
		]
		const minX = Math.max(0, Math.floor(Math.min(...corners.map(([px]) => px))))
		const maxX = Math.min(this.canvas.width, Math.ceil(Math.max(...corners.map(([px]) => px))))
		const minY = Math.max(0, Math.floor(Math.min(...corners.map(([, py]) => py))))
		const maxY = Math.min(this.canvas.height, Math.ceil(Math.max(...corners.map(([, py]) => py))))
		const determinant = a * d - b * c
		if (!determinant) return
		for (let py = minY; py < maxY; py++)
			for (let px = minX; px < maxX; px++) {
				const localX = (d * (px + 0.5 - e) - c * (py + 0.5 - f)) / determinant
				const localY = (-b * (px + 0.5 - e) + a * (py + 0.5 - f)) / determinant
				if (localX < x || localX >= x + width || localY < y || localY >= y + height) continue
				visit((py * this.canvas.width + px) * 4)
			}
	}
}

function transform(x: number, y: number, [a, b, c, d, e, f]: Matrix): [number, number] {
	return [a * x + c * y + e, b * x + d * y + f]
}

function parseColor(value: string): Color {
	const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1]
	if (hex) {
		return [
			Number.parseInt(hex.slice(0, 2), 16),
			Number.parseInt(hex.slice(2, 4), 16),
			Number.parseInt(hex.slice(4, 6), 16),
			1
		]
	}
	const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value)
	if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])]
	throw new Error(`Unsupported fill style: ${value}`)
}

function blend(pixels: Uint8Array, index: number, color: Color, sourceAlpha: number): void {
	if (sourceAlpha <= 0) return
	if (sourceAlpha >= 1) {
		pixels[index] = color[0]
		pixels[index + 1] = color[1]
		pixels[index + 2] = color[2]
		pixels[index + 3] = 255
		return
	}
	const destinationAlpha = (pixels[index + 3] ?? 0) / 255
	const alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha)
	for (let channel = 0; channel < 3; channel++)
		pixels[index + channel] = Math.round(
			((color[channel] ?? 0) * sourceAlpha +
				(pixels[index + channel] ?? 0) * destinationAlpha * (1 - sourceAlpha)) /
				alpha
		)
	pixels[index + 3] = Math.round(alpha * 255)
}

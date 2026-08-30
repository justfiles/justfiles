// Regenerates every branded icon from the built-in avatar: the source icon, PWA icons, and favicon.
// Run with `pnpm run icons` after changing the avatar or the green in brand.ts.
//
// The agent's avatar is NOT here: it and its five other expressions are derived from
// art/mascot.svg by `pnpm run faces` (scripts/generate-faces.ts).
//
// The source icon is a transparent, reduced-motion frame of the same Game Boy avatar the shell
// renders at runtime. We trim it to the artwork and composite it over a subtle green gradient.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CanvasFrame } from '@justfiles/avatar'
import { drawGameboy } from '@justfiles/avatar'
import sharp from 'sharp'
import { background, PNG } from './brand.ts'

const dir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dir, '..')
const SRC = path.join(root, 'icon.png')
const PUBLIC = path.join(root, 'public')
const AVATAR_SIZE = 256

type Matrix = [number, number, number, number, number, number]

class RasterContext {
	readonly canvas = { width: AVATAR_SIZE, height: AVATAR_SIZE }
	readonly pixels = Buffer.alloc(AVATAR_SIZE * AVATAR_SIZE * 4)
	fillStyle = '#000000'
	globalAlpha = 1
	imageSmoothingEnabled = false
	private matrix: Matrix = [1, 0, 0, 1, 0, 0]
	private readonly stack: { matrix: Matrix; alpha: number }[] = []

	clearRect(): void {
		this.pixels.fill(0)
	}

	fillRect(x: number, y: number, width: number, height: number): void {
		const [a, b, c, d, e, f] = this.matrix
		const corners = [
			transform(x, y, this.matrix),
			transform(x + width, y, this.matrix),
			transform(x, y + height, this.matrix),
			transform(x + width, y + height, this.matrix)
		]
		const minX = Math.max(0, Math.floor(Math.min(...corners.map(([px]) => px))))
		const maxX = Math.min(AVATAR_SIZE, Math.ceil(Math.max(...corners.map(([px]) => px))))
		const minY = Math.max(0, Math.floor(Math.min(...corners.map(([, py]) => py))))
		const maxY = Math.min(AVATAR_SIZE, Math.ceil(Math.max(...corners.map(([, py]) => py))))
		const determinant = a * d - b * c
		if (!determinant) return
		const color = parseColor(this.fillStyle)
		const sourceAlpha = color[3] * this.globalAlpha
		for (let py = minY; py < maxY; py++)
			for (let px = minX; px < maxX; px++) {
				const localX = (d * (px + 0.5 - e) - c * (py + 0.5 - f)) / determinant
				const localY = (-b * (px + 0.5 - e) + a * (py + 0.5 - f)) / determinant
				if (localX < x || localX >= x + width || localY < y || localY >= y + height) continue
				blend(this.pixels, (py * AVATAR_SIZE + px) * 4, color, sourceAlpha)
			}
	}

	save(): void {
		this.stack.push({ matrix: [...this.matrix], alpha: this.globalAlpha })
	}

	restore(): void {
		const state = this.stack.pop()
		if (!state) return
		this.matrix = state.matrix
		this.globalAlpha = state.alpha
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
}

function transform(x: number, y: number, [a, b, c, d, e, f]: Matrix): [number, number] {
	return [a * x + c * y + e, b * x + d * y + f]
}

function parseColor(value: string): [number, number, number, number] {
	const hex = /^#([0-9a-f]{6})$/i.exec(value)
	if (hex) {
		return [
			Number.parseInt(hex[1].slice(0, 2), 16),
			Number.parseInt(hex[1].slice(2, 4), 16),
			Number.parseInt(hex[1].slice(4, 6), 16),
			1
		]
	}
	const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value)
	if (rgba) return [+rgba[1], +rgba[2], +rgba[3], +rgba[4]]
	throw new Error(`Unsupported fill style: ${value}`)
}

function blend(
	pixels: Buffer,
	index: number,
	color: [number, number, number, number],
	sourceAlpha: number
): void {
	if (sourceAlpha <= 0) return
	if (sourceAlpha >= 1) {
		pixels[index] = color[0]
		pixels[index + 1] = color[1]
		pixels[index + 2] = color[2]
		pixels[index + 3] = 255
		return
	}
	const destinationAlpha = pixels[index + 3] / 255
	const alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha)
	for (let channel = 0; channel < 3; channel++)
		pixels[index + channel] = Math.round(
			(color[channel] * sourceAlpha +
				pixels[index + channel] * destinationAlpha * (1 - sourceAlpha)) /
				alpha
		)
	pixels[index + 3] = Math.round(alpha * 255)
}

function renderAvatar(): Buffer {
	const context = new RasterContext()
	const frame: CanvasFrame = {
		time: 0,
		expression: null,
		previousExpression: null,
		expressionChangedAt: 0,
		reducedMotion: true
	}
	drawGameboy(context as never, frame)
	return context.pixels
}

// Centre the artwork at `frac` of the canvas over the green background.
async function icon(smiley: Buffer, size: number, frac: number, out: string): Promise<void> {
	const inner = Math.round(size * frac)
	const fg = await sharp(smiley)
		.resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.toBuffer()
	await sharp(background(size))
		.composite([{ input: fg, gravity: 'center' }])
		.png(PNG)
		.toFile(out)
}

async function transparentIcon(
	smiley: Buffer,
	size: number,
	frac: number,
	out: string
): Promise<void> {
	const inner = Math.round(size * frac)
	const fg = await sharp(smiley)
		.resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.toBuffer()
	await sharp({
		create: {
			width: size,
			height: size,
			channels: 4,
			background: { r: 0, g: 0, b: 0, alpha: 0 }
		}
	})
		.composite([{ input: fg, gravity: 'center' }])
		.png(PNG)
		.toFile(out)
}

await sharp(renderAvatar(), { raw: { width: AVATAR_SIZE, height: AVATAR_SIZE, channels: 4 } })
	.resize(1024, 1024, { kernel: sharp.kernel.nearest })
	.png(PNG)
	.toFile(SRC)
const smiley = await sharp(SRC).trim().png().toBuffer()
await Promise.all([
	// PWA: square "any" icons plus a maskable one with a safe-zone inset.
	icon(smiley, 192, 0.82, path.join(PUBLIC, 'pwa-192.png')),
	icon(smiley, 512, 0.82, path.join(PUBLIC, 'pwa-512.png')),
	icon(smiley, 512, 0.62, path.join(PUBLIC, 'pwa-maskable-512.png')),
	// The browser favicon stays transparent; iOS home-screen icons use the brand field.
	transparentIcon(smiley, 32, 0.86, path.join(PUBLIC, 'favicon.png')),
	icon(smiley, 180, 0.8, path.join(PUBLIC, 'apple-touch-icon.png'))
])
console.log('icons written')

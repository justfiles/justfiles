// Regenerates every branded icon from icon.png: the PWA icons, the favicon, and
// the agent's default avatar. Run with `pnpm run icons` after editing icon.png
// or the green below.
//
// icon.png is a white smiley with a checkerboard baked in as OPAQUE pixels (it
// only looks transparent). We flood-fill that light background away from the
// borders — the dark outline is a natural barrier that protects the white face —
// then composite the cutout over a subtle green radial gradient.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const dir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dir, '..')
const SRC = path.join(root, 'icon.png')
const PUBLIC = path.join(root, 'public')

// Subtle, elegant green: a brighter emerald centre fading to a deeper forest
// edge gives the flat cutout some depth without shouting.
const CENTRE = '#4d8c69'
const EDGE = '#2e6349'

function background(size: number): Buffer {
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
			`<defs><radialGradient id="g" cx="50%" cy="42%" r="75%">` +
			`<stop offset="0%" stop-color="${CENTRE}"/>` +
			`<stop offset="100%" stop-color="${EDGE}"/>` +
			`</radialGradient></defs>` +
			`<rect width="${size}" height="${size}" fill="url(#g)"/></svg>`
	)
}

// Flood-fill the baked-in background to alpha 0, then trim to the smiley.
async function cutout(): Promise<Buffer> {
	const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
	const { width: w, height: h, channels: c } = info
	const T = 130 // background is >=197 bright; the outline core sits ~55, well below.
	const bright = (i: number) => Math.min(data[i * c], data[i * c + 1], data[i * c + 2])
	const bg = new Uint8Array(w * h)
	const stack: number[] = []
	const push = (x: number, y: number) => {
		const i = y * w + x
		if (!bg[i] && bright(i) >= T) {
			bg[i] = 1
			stack.push(i)
		}
	}
	for (let x = 0; x < w; x++) {
		push(x, 0)
		push(x, h - 1)
	}
	for (let y = 0; y < h; y++) {
		push(0, y)
		push(w - 1, y)
	}
	while (stack.length) {
		const i = stack.pop() as number
		const x = i % w
		const y = (i / w) | 0
		if (x > 0) push(x - 1, y)
		if (x < w - 1) push(x + 1, y)
		if (y > 0) push(x, y - 1)
		if (y < h - 1) push(x, y + 1)
	}
	for (let i = 0; i < w * h; i++) if (bg[i]) data[i * c + 3] = 0
	const png = await sharp(Buffer.from(data), { raw: { width: w, height: h, channels: c } })
		.png()
		.toBuffer()
	return sharp(png).trim().png().toBuffer()
}

// Centre the cutout at `frac` of the canvas over the green background.
async function icon(smiley: Buffer, size: number, frac: number, out: string): Promise<void> {
	const inner = Math.round(size * frac)
	const fg = await sharp(smiley)
		.resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.toBuffer()
	await sharp(background(size))
		.composite([{ input: fg, gravity: 'center' }])
		.png()
		.toFile(out)
}

const smiley = await cutout()
await Promise.all([
	// PWA: square "any" icons plus a maskable one with a safe-zone inset.
	icon(smiley, 192, 0.82, path.join(PUBLIC, 'pwa-192.png')),
	icon(smiley, 512, 0.82, path.join(PUBLIC, 'pwa-512.png')),
	icon(smiley, 512, 0.62, path.join(PUBLIC, 'pwa-maskable-512.png')),
	// Favicon + iOS home-screen icon.
	icon(smiley, 32, 0.86, path.join(PUBLIC, 'favicon.png')),
	icon(smiley, 180, 0.8, path.join(PUBLIC, 'apple-touch-icon.png')),
	// The agent's default avatar (shown in a circle by the shell).
	icon(smiley, 256, 0.76, path.join(root, 'src/agent/agent-avatar.png'))
])
console.log('icons written')

// Regenerates every branded icon from icon.png: the PWA icons, the favicon, and
// the agent's default avatar. Run with `pnpm run icons` after editing icon.png
// or the green below.
//
// icon.png is the white smiley on a transparent background; we trim it to the
// artwork and composite it over a subtle green radial gradient.
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

// A smooth radial gradient balloons a truecolor PNG (the 512 was ~100 KB). These
// icons are just a few flat colours plus that gradient, so a palette quantises them
// to a third of the size; quality 96 keeps the mean per-channel error ~0.3/255 —
// visually identical, no banding. compressionLevel/effort are maxed (lossless deflate).
const PNG = { palette: true, quality: 96, dither: 0.5, compressionLevel: 9, effort: 10 } as const

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

const smiley = await sharp(SRC).trim().png().toBuffer()
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

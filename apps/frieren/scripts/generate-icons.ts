// Regenerates every branded icon from icon.png: the PWA icons and the favicon.
// Run with `pnpm run icons` after editing icon.png or the green in brand.ts.
//
// The agent's avatar is NOT here: it and its five other expressions are derived from
// art/mascot.svg by `pnpm run faces` (scripts/generate-faces.ts).
//
// icon.png is the white smiley on a transparent background; we trim it to the
// artwork and composite it over a subtle green radial gradient.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { background, PNG } from './brand.ts'

const dir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dir, '..')
const SRC = path.join(root, 'icon.png')
const PUBLIC = path.join(root, 'public')

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
	icon(smiley, 180, 0.8, path.join(PUBLIC, 'apple-touch-icon.png'))
])
console.log('icons written')

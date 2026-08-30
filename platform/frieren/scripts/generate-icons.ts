// Regenerates Frieren's source icon, PWA icons, and favicon from the built-in avatar.
// Run with `pnpm run icons` after changing the avatar or the green in brand.ts.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gameboyAvatar } from '@justfiles/avatar'
import sharp from 'sharp'
import { background, PNG } from './brand.ts'

const dir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dir, '..')
const SRC = path.join(root, 'icon.png')
const PUBLIC = path.join(root, 'public')

async function icon(
	art: Buffer,
	size: number,
	fraction: number,
	out: string,
	field?: Buffer
): Promise<void> {
	const inner = Math.round(size * fraction)
	const foreground = await sharp(art)
		.resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.toBuffer()
	const canvas = field
		? sharp(field)
		: sharp({
				create: {
					width: size,
					height: size,
					channels: 4,
					background: { r: 0, g: 0, b: 0, alpha: 0 }
				}
			})
	await canvas
		.composite([{ input: foreground, gravity: 'center' }])
		.png(PNG)
		.toFile(out)
}

const rendered = gameboyAvatar.render()
await sharp(rendered.data, {
	raw: { width: rendered.width, height: rendered.height, channels: 4 }
})
	.resize(1024, 1024, { kernel: sharp.kernel.nearest })
	.png(PNG)
	.toFile(SRC)
const art = await sharp(SRC).trim().png().toBuffer()

await Promise.all([
	icon(art, 192, 0.82, path.join(PUBLIC, 'pwa-192.png'), background(192)),
	icon(art, 512, 0.82, path.join(PUBLIC, 'pwa-512.png'), background(512)),
	icon(art, 512, 0.62, path.join(PUBLIC, 'pwa-maskable-512.png'), background(512)),
	icon(art, 32, 0.86, path.join(PUBLIC, 'favicon.png')),
	icon(art, 180, 0.8, path.join(PUBLIC, 'apple-touch-icon.png'), background(180))
])

console.log('icons written')

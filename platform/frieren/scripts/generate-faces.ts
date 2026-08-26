// The built-in face matrix: `pnpm run faces`.
//
// Every built-in avatar the summoning offers, in every expression the agent can tag,
// baked at build time and checked in — so a user who never uploads a photo has a full
// expression set and the runtime image engine is never asked to derive one (worker/faces.ts
// then only serves genuinely unknown art: an uploaded photo).
//
// Two stages, because a bad archetype base would poison all six of its expressions:
//
//   art/mascot.svg ──render──▶ art/bases/vanilla.png        (1024², the brand mark)
//         ├─[edit] "add round spectacles…" ─▶ art/bases/teacher.png     ┐ frozen, checked
//         ├─[edit] "add a football…"       ─▶ art/bases/companion.png   │ in, and reviewed
//         └─[edit] "add a pencil…"         ─▶ art/bases/assistant.png   ┘ before stage two
//                                    │
//                                    ▼
//        each base × EXPRESSIONS ─[edit facePrompt(e)]─▶ packages/agent/avatars/<id>/<e>.png
//
// The expression edit uses `facePrompt` from @justfiles/agent/expression — the SAME prompt
// the runtime path sends for an uploaded avatar. One definition of "pleased", so a built-in
// face and a generated one are siblings rather than two unrelated ideas.
//
// `neutral` is never generated — calm is not an emotion the agent tags, it is where the face
// rests, so `resting.png` is the base itself. The brand is not a paraphrase of itself.
//
// Cost is ~$0.004 an image, so a full bake is about ten cents. Every cell is cached on
// disk anyway: a re-run pays for nothing that already exists. `--force` re-bakes the pixels
// from the engine's cached answer (free), `--reroll` asks it again, and either can be
// narrowed with `--variant=teacher --expression=curious`.
//
// Never runs in CI (it needs a key and it costs money). The checked-in output is the
// product; faces.builtin.test.ts is what notices when it goes stale.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createImagesModels } from '@earendil-works/pi-ai'
import { openrouterImagesProvider } from '@earendil-works/pi-ai/providers/openrouter-images'
import { EXPRESSIONS, type Expression, facePrompt } from '@justfiles/agent/expression'
import sharp from 'sharp'
import { AVATAR_FRAC, background, PNG } from './brand.ts'

const dir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dir, '..')
const MASCOT = path.join(root, 'art/mascot.svg')
const art = readFileSync(MASCOT, 'utf8')
const BASES = path.join(root, 'art/bases')
const RAW = path.join(root, 'art/.raw')
// The art belongs to @justfiles/agent: BOTH hosts serve `agent.listAvatars` and the shell
// renders the faces, so the one place all of them can import from is the package. The bake
// step below turns the files into the module they actually import.
const OUT = path.resolve(root, '../../packages/agent/avatars')
const BAKE = path.join(dir, 'bake-avatars.ts')
const SHEET = path.join(root, 'art/faces-sheet.png')

// The engine edits at ~1024²; the shell only ever shows 256² (and `squareImage` normalises an
// uploaded photo to the same square), so that is what ships. PNG here by decision — the
// bundled art is checked in for human review, and 256² palette PNG is 4 KB.
const EDIT_SIZE = 1024
const SIZE = 256
// The same model the runtime path uses, so both stages of this and the lazy fallback agree.
const MODEL = 'google/gemini-3.1-flash-image'
// The mark is two flat colours on a gradient, so the returned art is snapped back to them:
// it removes the model's re-dithering and any colour it invents (grey lens fill, tinted
// outline) without touching WHAT it drew. Turn this OFF for a detailed mascot — on an
// illustration it would flatten real shading.
const FLATTEN = true

// `neutral` is not one of them: calm is where the face RESTS, not something the agent claims
// (see @justfiles/agent/expression), so each variant gets a `resting.png` — the base itself,
// never a model paraphrase of the brand — plus one file per emotion.
const RESTING = 'resting'
const COLUMNS: readonly (typeof RESTING | Expression)[] = [RESTING, ...EXPRESSIONS]

// The three natures the summoning offers (justfiles/app-settings), plus the one a user who
// never personalised is already wearing. No gender variants: the character has no gender
// signifiers to vary, and the accessory carries the archetype on its own.
//
// Each accessory sits in a different zone of the silhouette — on the face, past the left
// edge, past the right — so they stay apart at favicon size, where a detail is three pixels.
const VARIANTS: { id: string; accessory?: string }[] = [
	{ id: 'vanilla' },
	{
		id: 'teacher',
		accessory:
			'Add round spectacles: thin rims in the same dark colour and line weight as the outline, one lens over each eye, a bridge between them, short arms to the sides. The lenses are clear and empty — both eyes stay fully visible and unchanged through them.'
	},
	{
		id: 'companion',
		accessory:
			"Add a football (soccer ball) resting beside the head at the lower LEFT, small — about a third of the head's width — and overlapping the head's outline a little so it sits in front of the character. Draw it in the same flat style: white with the same dark outline and line weight, and a few solid dark pentagon patches."
	},
	{
		id: 'assistant',
		accessory:
			'Add a pencil tucked behind the head, angled so the shaft and its sharpened tip show past the upper RIGHT edge. Draw it in the same flat style: white with the same dark outline and line weight as the character.'
	}
]

// The constraints `facePrompt` closes with, so an accessory edit is held to the same bar.
function accessoryPrompt(accessory: string): string {
	return [
		accessory,
		'Keep the same character, art style, colours, lighting, framing, crop and background.',
		'Do not change the face, the expression or the composition.',
		'Output one square image.'
	].join(' ')
}

// ── cli ────────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const force = args.includes('--force')
const reroll = args.includes('--reroll')
const onlyVariant = flag('variant')
const onlyExpression = flag('expression')
// A cell is redrawn when it is missing, or when --force/--reroll names it. `--expression`
// narrows to faces, so it never re-rolls a base out from under the other five.
const redraw = force || reroll
const inScope = (variant: string, face?: string) =>
	(!onlyVariant || onlyVariant === variant) && (!onlyExpression || onlyExpression === face)

// ── the engine ─────────────────────────────────────────────────────────────────────────

function apiKey(): string {
	if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY
	const vars = path.join(root, '.dev.vars')
	const found =
		existsSync(vars) && /^OPENROUTER_API_KEY\s*=\s*"?([^"\n]+)"?/m.exec(readFileSync(vars, 'utf8'))
	if (!found)
		throw new Error('no OPENROUTER_API_KEY in the environment or platform/frieren/.dev.vars')
	return found[1]
}

const credential = { type: 'api_key', key: apiKey() } as const
const images = createImagesModels({
	credentials: {
		read: async (id: string) => (id === 'openrouter' ? credential : undefined),
		list: async () => [{ providerId: 'openrouter', type: 'api_key' }],
		modify: async (_id: string, fn: (c: unknown) => unknown) => fn(credential),
		delete: async () => {}
	} as never
})
images.setProvider(openrouterImagesProvider())
const resolved = images.getModel('openrouter', MODEL)
if (!resolved) throw new Error(`the images stack has no ${MODEL}`)
const model = resolved

let spent = 0
let calls = 0

// One edit: source image in, one image out. Throws on a refusal — a silently skipped cell
// would leave a hole in a matrix that is only ever reviewed as a whole.
async function edit(what: string, prompt: string, source: Buffer): Promise<Buffer> {
	const result = await images.generateImages(model, {
		input: [
			{ type: 'text', text: prompt },
			{ type: 'image', data: source.toString('base64'), mimeType: 'image/png' }
		]
	})
	calls++
	spent += result.usage?.cost?.total ?? 0
	if (result.stopReason !== 'stop')
		throw new Error(`${what}: ${result.errorMessage ?? result.stopReason}`)
	const image = result.output.find((block) => block.type === 'image')
	if (!image || image.type !== 'image') throw new Error(`${what}: the engine returned no image`)
	return Buffer.from(image.data, 'base64')
}

// ── normalise ──────────────────────────────────────────────────────────────────────────

// The mark is achromatic (white fill, dark outline) and the field is green, so how far a
// pixel is from grey separates the two — with the anti-aliased edge landing in between,
// which is what keeps the outline smooth instead of stair-stepped.
const CHROMA = 34

function matte(r: number, g: number, b: number): number {
	const chroma = Math.max(r, g, b) - Math.min(r, g, b)
	return 1 - Math.min(1, chroma / CHROMA)
}

// The outline's own value, read off the art so a re-skinned mascot keeps its line colour.
const INK = (() => {
	const stroke = /id="head"[^>]*stroke="#([0-9a-fA-F]{6})"/.exec(art)?.[1]
	if (!stroke) throw new Error('art/mascot.svg: #head has no stroke="#rrggbb"')
	const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(stroke.slice(i, i + 2), 16))
	return (r + g + b) / 3
})()

// A steep ramp, not a hard threshold: an interior mid-grey the model invented is pushed to
// white or to the outline colour, while an edge pixel — which crosses the whole range within
// a pixel or two — still gets a smooth value. The ends CLAMP, so a flat fill comes out
// exactly flat: leave it merely close and the palette quantiser dithers two near-whites
// against each other, which is a visible mottle on a face this plain.
function snap(level: number): number {
	const t = Math.min(1, Math.max(0, (level - INK) / (255 - INK)))
	let s = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)
	if (s > 0.94) s = 1
	if (s < 0.06) s = 0
	return INK + s * (255 - INK)
}

// Returned art → the square that ships: resized, re-seated on a freshly drawn gradient, and
// (when FLATTEN) snapped back to the brand's two greys.
async function normalise(raw: Buffer, size: number): Promise<Buffer> {
	const square = sharp(raw).resize(size, size, { fit: 'fill' })
	if (!FLATTEN) return square.png(PNG).toBuffer()
	const flat = await square.removeAlpha().raw().toBuffer()
	const field = await sharp(background(size)).removeAlpha().raw().toBuffer()
	const out = Buffer.alloc(flat.length)
	for (let i = 0; i < flat.length; i += 3) {
		const r = flat[i]
		const g = flat[i + 1]
		const b = flat[i + 2]
		const a = matte(r, g, b)
		const ink = snap((r + g + b) / 3)
		for (let c = 0; c < 3; c++) out[i + c] = Math.round(a * ink + (1 - a) * field[i + c])
	}
	return sharp(out, { raw: { width: size, height: size, channels: 3 } })
		.png(PNG)
		.toBuffer()
}

// Where the ink sits, for the drift gate below. `within` restricts the scan to a region, so
// an accessory drawn OUTSIDE the head cannot be mistaken for the head having moved.
type Box = {
	x0: number
	y0: number
	x1: number
	y1: number
	w: number
	h: number
	cx: number
	cy: number
	scale: number
}

async function markBox(png: Buffer, within?: Box): Promise<Box> {
	const size = 256
	const { data } = await sharp(png)
		.resize(size, size, { fit: 'fill' })
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true })
	let x0 = size
	let y0 = size
	let x1 = -1
	let y1 = -1
	const from = within ?? { x0: 0, y0: 0, x1: size - 1, y1: size - 1 }
	for (let y = from.y0; y <= from.y1; y++)
		for (let x = from.x0; x <= from.x1; x++) {
			const i = (y * size + x) * 3
			if (matte(data[i], data[i + 1], data[i + 2]) < 0.6) continue
			if (x < x0) x0 = x
			if (x > x1) x1 = x
			if (y < y0) y0 = y
			if (y > y1) y1 = y
		}
	return {
		x0,
		y0,
		x1,
		y1,
		w: x1 - x0 + 1,
		h: y1 - y0 + 1,
		cx: (x0 + x1) / 2,
		cy: (y0 + y1) / 2,
		scale: size
	}
}

// An edit that moved or resized the character is a failed edit, however good it looks on its
// own: the avatar swaps these images in place, so a head that grows between expressions
// reads as a glitch.
//
// `headOnly` is for the accessory stage, where the ink is MEANT to spill outside the head:
// the scan is clipped to the head's own box, which an accessory can then only fail by
// eating into it.
async function assertNoDrift(
	what: string,
	base: Buffer,
	result: Buffer,
	headOnly = false
): Promise<void> {
	const a = await markBox(base)
	const b = await markBox(result, headOnly ? a : undefined)
	const moved = Math.max(Math.abs(a.cx - b.cx), Math.abs(a.cy - b.cy)) / a.scale
	const resized = Math.max(Math.abs(b.w - a.w) / a.w, Math.abs(b.h - a.h) / a.h)
	if (moved > 0.02 || resized > 0.06)
		throw new Error(
			`${what}: the character drifted — moved ${(moved * 100).toFixed(1)}%, resized ${(resized * 100).toFixed(1)}%. Re-roll it with --force.`
		)
}

// One cell: edit, normalise, and prove the character didn't drift — retrying, because a
// drifted frame is a dice roll rather than a broken prompt, and another roll costs $0.004.
//
// The engine's answer is kept in art/.raw (git-ignored) so re-normalising is free and changes
// nothing about the art: `--force` re-bakes the pixels from what the engine already said,
// `--reroll` throws the dice again. Tuning the flattening must not cost a fresh set of faces
// you then have to re-review.
const ATTEMPTS = 3

async function draw(
	what: string,
	prompt: string,
	source: Buffer,
	size: number,
	raw: string,
	headOnly = false
): Promise<Buffer> {
	let last: Error | undefined
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		try {
			// Only the first attempt may reuse the cache: a cached answer that failed the gate would
			// otherwise fail identically forever.
			const cached = attempt === 1 && !reroll && existsSync(raw)
			const answer = cached ? readFileSync(raw) : await edit(what, prompt, source)
			if (!cached) {
				mkdirSync(path.dirname(raw), { recursive: true })
				writeFileSync(raw, answer)
			}
			const png = await normalise(answer, size)
			await assertNoDrift(what, source, png, headOnly)
			return png
		} catch (error) {
			// Both halves are a dice roll: the engine sometimes answers with no image at all, and an
			// answer that looks fine sometimes drifted. Either way the remedy is another roll.
			last = error as Error
			console.log(`  ${last.message} (attempt ${attempt}/${ATTEMPTS})`)
		}
	}
	throw last
}

// ── stage one: the variant bases ───────────────────────────────────────────────────────

mkdirSync(BASES, { recursive: true })
const basePath = (variant: string) => path.join(BASES, `${variant}.png`)

// The brand mark on its green field, at edit size. libvips sniffs for `<svg` in the first
// bytes, so the file's header comment has to go before it will read it.
async function renderMascot(): Promise<Buffer> {
	const source = Buffer.from(art.replace(/^\s*<!--[\s\S]*?-->\s*/, ''))
	const mark = await sharp(source, { density: 300 })
		.resize(Math.round(EDIT_SIZE * AVATAR_FRAC), Math.round(EDIT_SIZE * AVATAR_FRAC), {
			fit: 'contain',
			background: { r: 0, g: 0, b: 0, alpha: 0 }
		})
		.png()
		.toBuffer()
	return sharp(background(EDIT_SIZE))
		.composite([{ input: mark, gravity: 'center' }])
		.png(PNG)
		.toBuffer()
}

if (force || !existsSync(basePath('vanilla'))) {
	writeFileSync(basePath('vanilla'), await renderMascot())
	console.log('art/bases/vanilla.png ← art/mascot.svg')
}
const vanilla = readFileSync(basePath('vanilla'))

for (const variant of VARIANTS) {
	if (!variant.accessory) continue
	const target = basePath(variant.id)
	const stale = redraw && !onlyExpression && inScope(variant.id)
	if (existsSync(target) && !stale) continue
	const what = `${variant.id} base`
	const png = await draw(
		what,
		accessoryPrompt(variant.accessory),
		vanilla,
		EDIT_SIZE,
		path.join(RAW, `${variant.id}-base.png`),
		true
	)
	writeFileSync(target, png)
	console.log(`art/bases/${variant.id}.png ← accessory edit`)
}

// ── stage two: an expression for every base ────────────────────────────────────────────

const written: { variant: string; face: string; png: Buffer }[] = []
for (const variant of VARIANTS) {
	mkdirSync(path.join(OUT, variant.id), { recursive: true })
	const base = readFileSync(basePath(variant.id))
	for (const face of COLUMNS) {
		const target = path.join(OUT, variant.id, `${face}.png`)
		const done = existsSync(target)
		if (done && !(redraw && inScope(variant.id, face))) {
			written.push({ variant: variant.id, face, png: readFileSync(target) })
			continue
		}
		if (!done && !inScope(variant.id, face)) continue
		// The face at rest IS the mark — never paraphrase the brand through the model.
		const png =
			face === RESTING
				? await normalise(base, SIZE)
				: await draw(
						`${variant.id}/${face}`,
						facePrompt(face),
						base,
						SIZE,
						path.join(RAW, variant.id, `${face}.png`)
					)
		writeFileSync(target, png)
		written.push({ variant: variant.id, face, png })
		console.log(`packages/agent/avatars/${variant.id}/${face}.png`)
	}
}

// ── the contact sheet: the whole matrix in one image, for review in a pull request ──────

const TILE = 128
const PAD = 8
const LABEL = 92
const sheetW = LABEL + COLUMNS.length * (TILE + PAD) + PAD
const sheetH = 30 + VARIANTS.length * (TILE + PAD) + PAD
const text = (x: number, y: number, anchor: string, value: string) =>
	`<text x="${x}" y="${y}" fill="#bdbdbd" font-family="sans-serif" font-size="15" text-anchor="${anchor}">${value}</text>`
const labels =
	`<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}">` +
	COLUMNS.map((face, i) => text(LABEL + i * (TILE + PAD) + TILE / 2, 20, 'middle', face)).join('') +
	VARIANTS.map((v, row) =>
		text(LABEL - 12, 30 + row * (TILE + PAD) + TILE / 2 + 5, 'end', v.id)
	).join('') +
	'</svg>'
await sharp({ create: { width: sheetW, height: sheetH, channels: 3, background: '#1b1b1b' } })
	.composite([
		...(await Promise.all(
			written.map(async (tile) => ({
				input: await sharp(tile.png).resize(TILE, TILE).toBuffer(),
				left: LABEL + COLUMNS.indexOf(tile.face as Expression) * (TILE + PAD),
				top: 30 + VARIANTS.findIndex((v) => v.id === tile.variant) * (TILE + PAD)
			}))
		)),
		{ input: Buffer.from(labels) }
	])
	.png()
	.toFile(SHEET)

// The PNGs are the art; `avatars.ts` is what every runtime can actually import (no bundler
// reads a PNG the same way, and the app frame's CSP only allows `data:`). Baked here so the
// two can never be committed out of step.
execFileSync('node', [BAKE], { stdio: 'inherit' })

console.log(
	`\n${written.length} faces in packages/agent/avatars (${VARIANTS.length} variants x ${COLUMNS.length} faces)`
)
console.log(`${calls} engine calls, $${spent.toFixed(3)}`)
console.log(`contact sheet: ${path.relative(root, SHEET)}`)

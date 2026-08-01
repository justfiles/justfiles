import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { imageDataUrl, imageFileNames, imageType, readImageFile } from './image-type.ts'

// The point of sniffing is that a NAME is a claim and the bytes are a fact — so the checked-in
// art is read here off disk, with its name deliberately ignored.
const ART = new URL('../agent/avatars/vanilla/resting.png', import.meta.url)
const bytes = (...values: number[]) => new Uint8Array(values)
const text = (value: string) => new TextEncoder().encode(value)

test('the real art identifies itself, whatever it is called', () => {
	const png = new Uint8Array(readFileSync(ART))
	expect(imageType(png)).toBe('image/png')
	expect(imageDataUrl(png)?.startsWith('data:image/png;base64,iVBOR')).toBe(true)
})

test.each([
	['png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1), 'image/png'],
	['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0, 1), 'image/jpeg'],
	['gif', text('GIF89a...'), 'image/gif'],
	// RIFF alone is not enough: WAV starts the same way and is not an image.
	['webp', bytes(...text('RIFF'), 0, 0, 0, 0, ...text('WEBP')), 'image/webp'],
	['wav', bytes(...text('RIFF'), 0, 0, 0, 0, ...text('WAVE')), null],
	['bmp', text('BM......'), 'image/bmp'],
	['avif', bytes(0, 0, 0, 0x20, ...text('ftyp'), ...text('avif')), 'image/avif'],
	['heic', bytes(0, 0, 0, 0x20, ...text('ftyp'), ...text('heic')), 'image/heic'],
	['mp4', bytes(0, 0, 0, 0x20, ...text('ftyp'), ...text('isom')), null],
	['svg', text('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'],
	['svg with a prolog', text('<?xml version="1.0"?>\n<svg/>'), 'image/svg+xml'],
	['nothing recognisable', text('hello, this is not art'), null],
	['empty', bytes(), null]
])('%s', (_name, input, expected) => {
	expect(imageType(input)).toBe(expected)
})

test('an unrecognised file gets no URL rather than a lie', () => {
	// A caller then treats that state as one it cannot render — better than an <img> pointed
	// at bytes the browser will refuse.
	expect(imageDataUrl(text('not an image'))).toBeNull()
})

// ── which file holds a state ───────────────────────────────────────────────

const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1)
const webp = bytes(...text('RIFF'), 0, 0, 0, 0, ...text('WEBP'))
const files = (entries: Record<string, Uint8Array>) => ({
	names: Object.keys(entries),
	read: async (name: string) => entries[name] ?? bytes()
})

test('the file holding a state is found by its stem, in any format', async () => {
	const { names, read } = files({ 'resting.webp': webp, 'pleased.png': png })
	expect(await readImageFile(names, 'resting', read)).toMatchObject({
		name: 'resting.webp',
		type: 'image/webp'
	})
	// The state may be named by any file that holds it, which is what lets a writer say
	// "replace `pleased.png`" and reach a `pleased.webp`.
	expect(await readImageFile(names, 'pleased.gif', read)).toMatchObject({ name: 'pleased.png' })
	expect(await readImageFile(names, 'curious', read)).toBeNull()
})

test('a candidate this build cannot render is skipped, not fatal', async () => {
	// The file next to the real one must not take the whole state down with it: `resting.aaa`
	// sorts first, and a reader that stopped there would call the avatar unusable.
	const { names, read } = files({ 'resting.aaa': text('not art'), 'resting.webp': webp })
	expect(await readImageFile(names, 'resting', read)).toMatchObject({
		name: 'resting.webp',
		type: 'image/webp'
	})
	// And when NOTHING claiming the state can be rendered, that is a state this build does
	// not have — the caller falls back rather than showing a broken portrait.
	const only = files({ 'resting.webm': text('not art') })
	expect(await readImageFile(only.names, 'resting', only.read)).toBeNull()
})

test('two files claiming one state resolve the same on every backend', async () => {
	// `putAvatarFile` makes this unreachable, but the Files app and a hand-unzipped pack can
	// still do it — and raw readdir is sorted on one backend and insertion-ordered on another,
	// so the winner must come from here. Sorted: arbitrary, but IDENTICAL everywhere.
	const shuffled = ['resting.webp', 'resting.png']
	expect(imageFileNames(shuffled, 'resting')).toEqual(['resting.png', 'resting.webp'])
	expect(imageFileNames([...shuffled].reverse(), 'resting')).toEqual([
		'resting.png',
		'resting.webp'
	])
	// A writer asks the same question to know what has to give way when it publishes a state.
	expect(imageFileNames(['resting.png', 'pleased.png'], 'resting.avif')).toEqual(['resting.png'])
})

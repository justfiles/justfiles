import { expect, test } from 'vitest'
import {
	colorWallpaper,
	hasBothOrigins,
	nameInSoul,
	normalizeHex,
	originKind,
	WALLPAPER_COLORS,
	wallpaperColor
} from './model.ts'
import type { AccountInfo } from './types.ts'

const cloudAccount: AccountInfo = {
	accountId: 'g@gmail.com',
	providerId: 'google',
	enabled: [],
	config: {},
	origin: { kind: 'cloud' }
}
const deviceAccount: AccountInfo = {
	accountId: 'chatgpt',
	providerId: 'chatgpt',
	enabled: ['ai'],
	config: {},
	origin: { kind: 'device', label: 'This Mac' }
}
// An older host that hasn't deployed `origin` yet.
const noOriginAccount: AccountInfo = {
	accountId: 'u@me.com',
	providerId: 'icloud',
	enabled: ['calendar'],
	config: {}
}

test('originKind degrades an absent origin to cloud rather than crashing', () => {
	expect(originKind(cloudAccount)).toBe('cloud')
	expect(originKind(deviceAccount)).toBe('device')
	expect(originKind(noOriginAccount)).toBe('cloud')
})

test('hasBothOrigins is true only once the list spans both lanes', () => {
	expect(hasBothOrigins([])).toBe(false)
	expect(hasBothOrigins([cloudAccount])).toBe(false)
	expect(hasBothOrigins([deviceAccount])).toBe(false)
	expect(hasBothOrigins([cloudAccount, deviceAccount])).toBe(true)
	// An account with no `origin` degrades to 'cloud', same as a real cloud account.
	expect(hasBothOrigins([noOriginAccount, deviceAccount])).toBe(true)
	expect(hasBothOrigins([noOriginAccount, cloudAccount])).toBe(false)
})

// ── the agent pane ────────────────────────────────────────────────────────

const boundSoul = {
	name: 'Fern',
	gender: 'female' as const,
	avatar: 'builtin/companion',
	body: 'You are Fern, a companion who walks beside the user.',
	seeded: false
}

test('nameInSoul spots the one drift a rename can cause, and nothing else', () => {
	expect(nameInSoul(boundSoul)).toBe('Fern')
	// Renamed in the frontmatter, not in the prose.
	expect(nameInSoul({ ...boundSoul, name: 'Frieren' })).toBe('Fern')
	// A name can have a space in it. Reading only the first word would report a rename
	// that never happened, on every render, forever.
	expect(nameInSoul({ ...boundSoul, body: 'You are Mary Jane, a companion.' })).toBe('Mary Jane')
	// Hand-written prose that opens some other way is not "drifted" — it is just prose.
	expect(nameInSoul({ ...boundSoul, body: 'Speak plainly, always.' })).toBeNull()
	// Nor is prose that opens with a description rather than a name.
	expect(nameInSoul({ ...boundSoul, body: 'You are a companion who listens.' })).toBeNull()
	expect(nameInSoul(null)).toBeNull()
})

// ── the wallpaper ─────────────────────────────────────────────────────────
// A colour IS a file: the pane writes the SVG below, and reads the colour back out of it.
// Nothing else in the system learns that colours exist, so this pair is the whole feature.

test('a colour round-trips through the file, and only through the file we write', () => {
	const bytes = colorWallpaper('#46534A')
	// One spelling on the volume — lower case — so comparing a preset to what is set is a
	// string comparison and never a colour-space one.
	expect(new TextDecoder().decode(bytes)).toContain('fill="#46534a"')
	expect(wallpaperColor(bytes)).toBe('#46534a')
	// Every preset survives the round trip, which is what rings the right chip on mount.
	for (const { hex } of WALLPAPER_COLORS) expect(wallpaperColor(colorWallpaper(hex))).toBe(hex)

	// A picture is not a colour, and neither is an SVG that came from somewhere else: it
	// reads as the picture it is, so the pane never claims to own it.
	expect(wallpaperColor(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
	expect(
		wallpaperColor(new TextEncoder().encode('<svg><rect fill="#46534a"/><circle/></svg>'))
	).toBeNull()
})

test('only #rrggbb is a colour', () => {
	expect(normalizeHex('  #46534A \n')).toBe('#46534a')
	for (const bad of ['#fff', 'moss', '#4653', 'rgb(0,0,0)', '#46534g']) {
		expect(normalizeHex(bad)).toBeNull()
	}
	expect(() => colorWallpaper('moss')).toThrow()
})

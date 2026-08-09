import type { AccountInfo, AvatarInfo } from '@justfiles/app/capabilities/settings'
import { expect, test } from 'vitest'
import {
	app,
	avatarStates,
	colorWallpaper,
	hasBothOrigins,
	initialState,
	isBound,
	nameInSoul,
	normalizeHex,
	originKind,
	WALLPAPER_COLORS,
	wallpaperColor,
	wornAvatar
} from './app.ts'

// Reducer-level, no DOM (AGENTS.md): the reducer's own fold + the pure origin
// helpers the GUI keys off, driven directly through `app.dispatch` — the same
// seam `app-notes/src/app.test.ts` uses.
//
// Drafting a soul is NOT here, on purpose: it is a window's work in progress, held in
// GUI-local React state (`useDrafting`), so there is no reducer path to drive.

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

test('accountsLoaded folds a listAccounts payload into state, origin intact', async () => {
	const { state } = await app.dispatch(
		{ type: '__cmd/accountsLoaded', params: { ok: true, value: [cloudAccount, deviceAccount] } },
		{ state: initialState }
	)
	expect(state?.accounts).toEqual([cloudAccount, deviceAccount])
})

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

const seededSoul = {
	name: 'Kodama',
	gender: null,
	avatar: null,
	body: 'You are Kodama, a calm and capable companion.',
	seeded: true
}
const boundSoul = {
	name: 'Fern',
	gender: 'female' as const,
	avatar: 'builtin/companion',
	body: 'You are Fern, a companion who walks beside the user.',
	seeded: false
}

test('a seeded soul reads as unbound, a written one as bound', async () => {
	const { state } = await app.dispatch(
		{ type: '__cmd/soulLoaded', params: { ok: true, value: seededSoul } },
		{ state: initialState }
	)
	expect(isBound(state?.soul ?? null)).toBe(false)
	const next = await app.dispatch(
		{ type: '__cmd/soulLoaded', params: { ok: true, value: boundSoul } },
		{ state: state ?? initialState }
	)
	expect(isBound(next.state?.soul ?? null)).toBe(true)
})

test('an avatar write moves state, so a face that changed alone still reaches the pane', async () => {
	// The soul is untouched by writing a photo: without the revision the state after the
	// write is identical, the kernel emits no update, and the pane keeps its old face.
	const start = { ...initialState, soul: boundSoul }
	const { state } = await app.dispatch({ type: 'avatarChanged', params: {} }, { state: start })
	expect(state?.avatarRevision).toBe(1)
	expect(state?.soul).toEqual(boundSoul)
})

test('usage being unavailable hides the meters but never the pane that holds the profile', async () => {
	const { state } = await app.dispatch(
		{
			type: '__cmd/usageLoaded',
			params: { ok: false, error: { message: 'CAPABILITY_UNAVAILABLE' } }
		},
		{ state: { ...initialState, category: 'account' } }
	)
	expect(state).toMatchObject({ usageAvailable: false, category: 'account' })
})

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

// ── the wardrobe ──────────────────────────────────────────────────────────
// An avatar is a directory the host describes; this app only ever matches refs.

const avatar = (over: Partial<AvatarInfo>): AvatarInfo => ({
	ref: 'builtin/vanilla',
	label: 'Vanilla',
	builtin: true,
	preview: 'data:image/png;base64,AA',
	files: ['resting.png', 'pleased.png', 'curious.png'],
	...over
})

test('the worn avatar is the ref in the soul, and an unknown one is the default', () => {
	const vanilla = avatar({})
	const mine = avatar({ ref: 'mine', label: 'Mine', builtin: false, files: ['resting.png'] })
	const list = [vanilla, mine]
	expect(wornAvatar({ ...boundSoul, avatar: 'mine' }, list)).toBe(mine)
	// No ref at all, and a ref naming a pack this device does not have: the default built-in
	// either way — which is what the shell paints too.
	expect(wornAvatar({ ...boundSoul, avatar: null }, list)).toBe(vanilla)
	expect(wornAvatar({ ...boundSoul, avatar: 'aurora' }, list)).toBe(vanilla)
	// Before the first list lands there is nothing to wear yet.
	expect(wornAvatar(boundSoul, [])).toBeUndefined()
})

test('the states worth a slot are the ones the built-in art covers', () => {
	// The expression vocabulary lives in @justfiles/agent, which this app cannot import — a
	// built-in covers every expression, so its files ARE the list, resting first. An avatar
	// on the volume contributes nothing: a missing face there is a gap, not a state.
	const states = avatarStates([
		avatar({}),
		avatar({ ref: 'mine', builtin: false, files: ['resting.png', 'sleepy.png'] })
	])
	expect(states).toEqual(['resting', 'curious', 'pleased'])
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

test('appearance is a category the sidebar can select', async () => {
	const { state } = await app.dispatch(
		{ type: 'selectCategory', params: { category: 'appearance' } },
		{ state: initialState }
	)
	expect(state?.category).toBe('appearance')
})

// The build itself is NOT reducer state (see `readVersion`) — the only thing the reducer
// knows about System is that the sidebar can select it.
test('system is a category the sidebar can select', async () => {
	const { state } = await app.dispatch(
		{ type: 'selectCategory', params: { category: 'system' } },
		{ state: initialState }
	)
	expect(state?.category).toBe('system')
})

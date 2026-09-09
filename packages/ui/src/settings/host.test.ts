import { hostAccounts } from '@justfiles/app/accounts/host'
import { icloudProvider } from '@justfiles/app/accounts/providers'
import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { expect, test, vi } from 'vitest'
import { createSettingsHost, type SettingsHostDeps } from './host.ts'
import type { AvatarInfo } from './types.ts'

const PATHS = {
	soul: '/system/agents/main/soul.md',
	avatars: '/system/agents/main/avatars',
	profile: '/system/user.md'
}

// What a MISSING file reads as, injected for the same reason. Nothing writes these to the
// Volume, so absence is the built-in identity — the pane opens on the same agent that is
// answering, not on an empty form.
const DEFAULTS = {
	soul: '---\nagent_name: Computer\nseeded: true\n---\n\nYou are Computer.\n',
	profile: '---\nseeded: true\n---\n'
}

// The art the app ships, injected for the same reason the paths are (it lives in
// `@justfiles/agent`, which depends on this package). Two states, so `files` has something
// to report and the pane has a list of states to offer.
const BUILTINS = {
	vanilla: { resting: 'data:image/png;base64,AA', states: ['resting', 'pleased'] }
}

function agentHost(over: Partial<SettingsHostDeps['agent']> = {}) {
	const vol = volume(memStore())
	const { admin: accounts } = hostAccounts([icloudProvider()], vol)
	return {
		vol,
		caps: createSettingsHost({
			accounts,
			agent: { volume: vol, paths: PATHS, defaults: DEFAULTS, builtins: BUILTINS, ...over }
		})
	}
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const encode = (text: string) => new TextEncoder().encode(text)
// Real signatures: what a state IS is read from its bytes, never from its name.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const WEBP = new Uint8Array([...encode('RIFF'), 0, 0, 0, 0, ...encode('WEBP')])

test('agent.writeSoul then readSoul round-trips, through the paths the host was handed', async () => {
	const { vol, caps } = agentHost()
	await caps.writeSoul({ name: 'Fern', gender: 'female', body: 'You are Fern.' })
	expect(await caps.readSoul({})).toEqual({
		name: 'Fern',
		gender: 'female',
		avatar: null,
		body: 'You are Fern.',
		seeded: false
	})
	// The file, not just the projection: the pane holds no path and no format.
	const text = decode(await vol.readFile(PATHS.soul))
	expect(text).toContain('schema: frieren/agent-soul/v1')
	expect(text).toContain('agent_name: Fern')
	expect(text).toContain('agent_gender: female')
	// Writing clears the seeded flag: this soul is the user's now.
	expect(text).not.toContain('seeded')
	expect(text.trimEnd().endsWith('You are Fern.')).toBe(true)
})

test('the built-in default reads as unbound, so the pane can send you to the summoning', async () => {
	const { vol, caps } = agentHost()
	// A soul file that IS the default — one a host wrote before defaults stopped being seeded,
	// or one synced from such a device (kept as a literal: this asserts the reading of a
	// defaulted file, not who produced it).
	await vol.mkdir('/system/agents/main', { recursive: true })
	await vol.writeFile(
		PATHS.soul,
		encode(
			'---\nschema: frieren/agent-soul/v1\nagent_name: Computer\nseeded: true\n---\n\nYou are Computer.\n'
		)
	)
	expect(await caps.readSoul({})).toMatchObject({
		name: 'Computer',
		body: 'You are Computer.',
		seeded: true
	})
	// NO FILE IS THE SAME STATE, down to the name and prose the pane shows: nothing seeds
	// these files any more, so absence has to read as the default rather than as an empty form
	// — otherwise a rename typed into a fresh account would write a soul with no persona in it.
	const virgin = agentHost()
	expect(await virgin.caps.readSoul({})).toMatchObject({
		name: 'Computer',
		body: 'You are Computer.',
		seeded: true
	})
})

// A patch merges with what `readSoul` reports, so the default standing in for a missing file
// has to be there too: renaming an agent nobody has bound must keep the built-in prose.
test('a rename against a volume with no soul keeps the built-in prose', async () => {
	const { vol, caps } = agentHost()

	await caps.writeSoul({ name: 'Fern' })

	expect(decode(await vol.readFile(PATHS.soul))).toContain('You are Computer.')
	expect(await caps.readSoul({})).toMatchObject({
		name: 'Fern',
		body: 'You are Computer.',
		// Written by the user now, whatever it still says.
		seeded: false
	})
})

test('a nature is never recorded — only the avatar it chose', async () => {
	const { vol, caps } = agentHost()
	await caps.writeSoul({
		name: 'Fern',
		gender: 'female',
		body: 'You teach by asking.',
		avatar: 'builtin/teacher'
	})
	expect(await caps.readSoul({})).toMatchObject({ avatar: 'builtin/teacher' })
	// The nature itself leaves no trace: the prose is the character, so a word claiming
	// otherwise could only ever disagree with it. What is recorded is a SOURCE for the art,
	// which for a built-in means no bytes on the volume at all.
	const text = decode(await vol.readFile(PATHS.soul))
	expect(text).not.toContain('archetype')
	expect(text).toContain('avatar: builtin/teacher')
	// A plain write keeps them dressed: the avatar is an ordinary patch field, so a rename
	// preserves it without anyone restating a rule about who may choose one.
	await caps.writeSoul({ name: 'Frieren', gender: 'female', body: 'Same.' })
	expect(await caps.readSoul({})).toMatchObject({
		name: 'Frieren',
		avatar: 'builtin/teacher'
	})
})

test('a soul write is a patch: a rename never carries an unfinished edit with it', async () => {
	// The sheet edits one field at a time — a rename saves on blur, the prose only when you
	// press Done — so a write that carried the whole sheet would commit the editor's
	// unfinished text every time the name or the gender was saved.
	const { caps } = agentHost()
	await caps.writeSoul({
		name: 'Fern',
		gender: 'female',
		body: 'You are Fern.',
		avatar: 'builtin/companion'
	})
	await caps.writeSoul({ name: 'Frieren' })
	expect(await caps.readSoul({})).toEqual({
		name: 'Frieren',
		gender: 'female',
		avatar: 'builtin/companion',
		body: 'You are Fern.',
		seeded: false
	})
})

test('an avatar is a directory: listAvatars shows the bundle then the volume', async () => {
	const { vol, caps } = agentHost()
	// Nothing installed yet: the built-in art alone, and it costs the volume nothing.
	expect(await caps.listAvatars({})).toEqual([
		{
			ref: 'builtin/vanilla',
			label: 'Vanilla',
			builtin: true,
			preview: 'data:image/png;base64,AA',
			files: ['resting', 'pleased']
		}
	])

	// One file per state, and the first one brings the avatar into being. A state may be
	// stored in any format — this one wears a WebP resting face, as a browser that can encode
	// WebP produces — and the file is named for the STATE either way.
	await caps.putAvatarFile({ avatar: 'mine', name: 'resting', bytes: WEBP })
	await caps.putAvatarFile({ avatar: 'mine', name: 'pleased', bytes: PNG })
	const [, mine] = (await caps.listAvatars({})) as AvatarInfo[]
	expect(mine).toMatchObject({ ref: 'mine', label: 'Mine', builtin: false })
	expect(mine?.files).toEqual(['pleased', 'resting'])
	expect(mine?.preview.startsWith('data:image/webp;base64,')).toBe(true)

	// Null bytes DELETE that state — the artist's file goes, the avatar stays.
	await caps.putAvatarFile({ avatar: 'mine', name: 'pleased', bytes: null })
	const [, after] = (await caps.listAvatars({})) as AvatarInfo[]
	expect(after?.files).toEqual(['resting'])

	// Derived art is the model's lane, and a directory with no resting state is not an
	// avatar yet: neither shows up as one to wear.
	await vol.mkdir(`${PATHS.avatars}/mine/.gen/abc`, { recursive: true })
	await vol.writeFile(`${PATHS.avatars}/mine/.gen/abc/curious.png`, PNG)
	await vol.mkdir(`${PATHS.avatars}/half`, { recursive: true })
	await vol.writeFile(`${PATHS.avatars}/half/pleased.png`, PNG)
	// And one whose resting bytes are not an image at all: also not offered, rather than
	// offered as a broken portrait.
	await vol.mkdir(`${PATHS.avatars}/broken`, { recursive: true })
	await vol.writeFile(`${PATHS.avatars}/broken/resting.png`, encode('not an image'))
	const list = (await caps.listAvatars({})) as AvatarInfo[]
	expect(list.map((a) => a.ref)).toEqual(['builtin/vanilla', 'mine'])
	expect(list[1]?.files).toEqual(['resting'])
})

test('an avatar is offered when ANY file claiming resting can be rendered', async () => {
	// The exact shape that made two readers disagree: `resting.aaa` sorts first and is not
	// art, so a picker that stopped there would hide an avatar the shell happily wears. Both
	// sides resolve through `readImageFile`, so there is one answer.
	const { vol, caps } = agentHost()
	await vol.mkdir(`${PATHS.avatars}/pack`, { recursive: true })
	await vol.writeFile(`${PATHS.avatars}/pack/resting.aaa`, encode('not art'))
	await vol.writeFile(`${PATHS.avatars}/pack/resting.webp`, WEBP)
	const [, pack] = (await caps.listAvatars({})) as AvatarInfo[]
	expect(pack?.ref).toBe('pack')
	expect(pack?.preview.startsWith('data:image/webp;base64,')).toBe(true)
})

test('no step of a publish can lose the state the user is wearing', async () => {
	// EVERY fallible step runs while the old file is still on the volume: the bytes land under
	// a name nothing resolves, the rename makes them the state, and only then is the file they
	// replaced taken out. Sweeping first would cost the user their portrait for good on the one
	// run where the rename failed — and it is the same file either way, so there is nothing to
	// restore it from.
	const vol = volume(memStore())
	let fail: 'write' | 'rename' | null = null
	const caps = createSettingsHost({
		agent: {
			paths: PATHS,
			defaults: DEFAULTS,
			builtins: BUILTINS,
			volume: Object.assign(Object.create(vol), {
				writeFile: (path: string, data: Uint8Array) =>
					fail === 'write' ? Promise.reject(new Error('ENOSPC')) : vol.writeFile(path, data),
				rename: (from: string, to: string) =>
					fail === 'rename' ? Promise.reject(new Error('EIO')) : vol.rename(from, to)
			})
		}
	})
	// A pack's PNG — a file the replacement does NOT write over, which is the case where an
	// early sweep leaves nothing behind.
	await vol.mkdir(`${PATHS.avatars}/mine`, { recursive: true })
	await vol.writeFile(`${PATHS.avatars}/mine/resting.png`, PNG)

	for (const step of ['write', 'rename'] as const) {
		fail = step
		await expect(
			caps.putAvatarFile({ avatar: 'mine', name: 'resting', bytes: WEBP })
		).rejects.toThrow()
		// Still exactly the portrait they had, and nothing staged is offered as a state.
		const [, mine] = (await caps.listAvatars({})) as AvatarInfo[]
		expect(mine?.files).toEqual(['resting.png'])
		expect(mine?.preview.startsWith('data:image/png;base64,')).toBe(true)
	}

	// And when it goes through, the file it replaced goes with it.
	fail = null
	await caps.putAvatarFile({ avatar: 'mine', name: 'resting', bytes: WEBP })
	const [, mine] = (await caps.listAvatars({})) as AvatarInfo[]
	expect(mine?.files).toEqual(['resting'])
	expect(mine?.preview.startsWith('data:image/webp;base64,')).toBe(true)
})

test('a write claims a STATE at ONE path, so one state can never be stored twice', async () => {
	// The uniqueness a state needs is not the one a filesystem gives: `resting` is the key, but
	// `resting.png` is the name. Two rules make that hold, and the second is what a filesystem
	// alone cannot do — the published file IS the state, so its name cannot vary with the
	// encoder the device happened to have (WebP here, PNG on a Safari that syncs with it), and
	// every other file claiming that state is swept, whatever a pack called it.
	const { vol, caps } = agentHost()
	const dir = `${PATHS.avatars}/mine`
	await vol.mkdir(dir, { recursive: true })
	await vol.writeFile(`${dir}/resting.webp`, WEBP)

	// The pane may ask by the name it is showing; what lands is the state.
	await caps.putAvatarFile({ avatar: 'mine', name: 'resting.webp', bytes: PNG })
	expect((await vol.readdir(dir)).map((e) => e.name)).toEqual(['resting'])
	// The same state published again in another format — the path a second device would write
	// to as well, so sync has one file to converge on instead of two nothing reconciles.
	await caps.putAvatarFile({ avatar: 'mine', name: 'resting', bytes: WEBP })
	expect((await vol.readdir(dir)).map((e) => e.name)).toEqual(['resting'])

	// And a DELETE drops the state in whatever format it is stored, so the pane can ask by
	// the name it happens to be showing.
	await caps.putAvatarFile({ avatar: 'mine', name: 'resting.jpg', bytes: null })
	expect(await vol.readdir(dir)).toEqual([])
})

test('putAvatarFile writes ONE file in ONE avatar, and nowhere else', async () => {
	const { caps } = agentHost()
	const bytes = new Uint8Array([1])
	for (const bad of [
		{ avatar: '../..', name: 'resting.png' },
		{ avatar: 'mine', name: '../soul.md' },
		{ avatar: 'mine', name: '.gen' },
		{ avatar: '.gen', name: 'resting.png' },
		{ avatar: '', name: 'resting.png' },
		{ avatar: 'mine', name: '' }
	]) {
		await expect(caps.putAvatarFile({ ...bad, bytes })).rejects.toMatchObject({
			message: 'Invalid settings input'
		})
	}
})

test('agent.readProfile / writeProfile carry only what the user chose to say', async () => {
	const { caps } = agentHost()
	expect(await caps.readProfile({})).toMatchObject({ name: '' })
	await caps.writeProfile({ name: 'Xiaoxing', birthDate: '1985-04-12', gender: 'male' })
	expect(await caps.readProfile({})).toEqual({
		name: 'Xiaoxing',
		birthDate: '1985-04-12',
		gender: 'male'
	})
})

test('agent.generateSoul is a preview: it reads the user from the volume and writes nothing', async () => {
	const seen: unknown[] = []
	const { caps } = agentHost({
		generateSoul: async (input) => {
			seen.push(input)
			return { body: 'A drafted soul.', firstWords: 'I am here.' }
		}
	})
	await caps.writeProfile({ name: 'Xiaoxing', birthDate: '1985-04-12', gender: 'male' })
	expect(
		await caps.generateSoul({ name: 'Fern', gender: 'female', archetype: 'companion' })
	).toEqual({ body: 'A drafted soul.', firstWords: 'I am here.' })
	// The host supplies who the user is, so no consumer derives an age from a date.
	expect(seen).toMatchObject([
		{ name: 'Fern', gender: 'female', archetype: 'companion', userGender: 'male' }
	])
	expect((seen[0] as { userAge: number }).userAge).toBeGreaterThan(30)
	// A preview never lands on the volume.
	expect(await caps.readSoul({})).toMatchObject({ seeded: true })
})

test("an age is counted in the USER's calendar, not the host's", async () => {
	// The frieren host is a worker on UTC while the user is somewhere else, so "today" has
	// to come from their timezone: at 17:00 in Los Angeles it is already tomorrow in UTC,
	// and a birthday tomorrow would otherwise count itself as already past.
	const seen: { userAge?: number }[] = []
	// Los Angeles is a day behind UTC late in its evening; pick the moment deliberately.
	const now = new Date('2026-08-01T03:00:00Z') // = 2026-07-31 20:00 in Los Angeles
	vi.setSystemTime(now)
	try {
		const { caps } = agentHost({
			timezone: () => 'America/Los_Angeles',
			generateSoul: async (input) => {
				seen.push(input)
				return { body: 'A drafted soul.' }
			}
		})
		// Their 30th birthday is 2026-08-01 — tomorrow where they are, today in UTC.
		await caps.writeProfile({ name: 'X', birthDate: '1996-08-01' })
		await caps.generateSoul({ name: 'Fern', gender: 'female', archetype: 'companion' })
		expect(seen[0]?.userAge).toBe(29)
	} finally {
		vi.useRealTimers()
	}
})

test("generation prefers the caller's facts: the generator need not run where they live", async () => {
	// In the browser this call is served by the Durable Object, whose copy of `user.md` is
	// a sync behind the one the user just typed into — so the caller sends what it read.
	const seen: { userAge?: number; userGender?: string }[] = []
	const { caps } = agentHost({
		generateSoul: async (input) => {
			seen.push(input)
			return { body: 'A drafted soul.' }
		}
	})
	// What THIS volume knows is deliberately different from what the caller sends.
	await caps.writeProfile({ birthDate: '1985-04-12', gender: 'male' })
	await caps.generateSoul({
		name: 'Fern',
		gender: 'female',
		archetype: 'companion',
		user: { birthDate: '2016-04-12', gender: 'female' }
	})
	expect(seen[0]?.userGender).toBe('female')
	expect(seen[0]?.userAge).toBeLessThan(20)
})

test('a profile write is a patch: it never puts back a field it was not given', async () => {
	// The pane saves per field as you edit, so a whole-profile write let a slower save
	// restore the value a faster one had just changed.
	const { caps } = agentHost({})
	await caps.writeProfile({ name: 'Xiaoxing', birthDate: '1985-04-12', gender: 'male' })
	await caps.writeProfile({ gender: 'female' })
	expect(await caps.readProfile({})).toEqual({
		name: 'Xiaoxing',
		birthDate: '1985-04-12',
		gender: 'female'
	})
})

test('no generator is UNAVAILABLE (a mac-shaped host), and the Volume methods still work', async () => {
	const { caps } = agentHost()
	await expect(
		caps.generateSoul({ name: 'F', gender: 'female', archetype: 'companion' })
	).rejects.toMatchObject({ message: 'SETTINGS_UNAVAILABLE' })
	await expect(caps.readSoul({})).resolves.toBeTruthy()
})

// ── appearance.* ──────────────────────────────────────────────────────────
// Appearance settings are one file each. Wallpaper bytes must be an image; dock material
// must be one known word. An absent setting and an unknown material read as null.

const WALLPAPER = '/system/wallpaper'
const DOCK_MATERIAL = '/system/dock-material'

function appearanceHost() {
	const vol = volume(memStore())
	return {
		vol,
		caps: createSettingsHost({
			appearance: { volume: vol, wallpaper: WALLPAPER, dockMaterial: DOCK_MATERIAL }
		})
	}
}

test('appearance.* round-trips the wallpaper bytes at the path the host was handed', async () => {
	const { vol, caps } = appearanceHost()
	// Nothing set yet is null, not an error: the shell is on its own default.
	expect(await caps.readWallpaper({})).toBeNull()

	await caps.writeWallpaper({ bytes: PNG })
	expect(await vol.readFile(WALLPAPER)).toEqual(PNG)
	expect(await caps.readWallpaper({})).toEqual(PNG)

	// A flat colour is bytes too — the SVG the Settings app writes for one. The host does
	// not know a colour from a photograph, which is what keeps this two methods.
	const svg = encode('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#23262a"/></svg>')
	await caps.writeWallpaper({ bytes: svg })
	expect(await caps.readWallpaper({})).toEqual(svg)

	// null removes the file, so the desktop falls back the same way it does on a device
	// where nobody ever set one.
	await caps.writeWallpaper({ bytes: null })
	expect(await vol.exists(WALLPAPER)).toBe(false)
	expect(await caps.readWallpaper({})).toBeNull()
})

test('bytes that are not an image are refused, so a desktop cannot be broken by a write', async () => {
	const { vol, caps } = appearanceHost()
	await expect(caps.writeWallpaper({ bytes: encode('%PDF-1.7') })).rejects.toMatchObject({
		message: 'Invalid settings input'
	})
	expect(await vol.exists(WALLPAPER)).toBe(false)
})

test('appearance.* stores one validated dock material word', async () => {
	const { vol, caps } = appearanceHost()
	expect(await caps.readDockMaterial({})).toBeNull()

	await caps.writeDockMaterial({ material: 'frosted' })
	expect(new TextDecoder().decode(await vol.readFile(DOCK_MATERIAL))).toBe('frosted')
	expect(await caps.readDockMaterial({})).toBe('frosted')

	await vol.writeFile(DOCK_MATERIAL, encode('unknown'))
	expect(await caps.readDockMaterial({})).toBeNull()
	await expect(caps.writeDockMaterial({ material: 'unknown' as never })).rejects.toMatchObject({
		message: 'Invalid settings input'
	})
})

test('concurrent field saves preserve both edits', async () => {
	const { caps } = agentHost()
	await Promise.all([
		caps.writeProfile({ name: 'Fern' }),
		caps.writeProfile({ birthDate: '1990-01-01' })
	])
	expect(await caps.readProfile({})).toMatchObject({ name: 'Fern', birthDate: '1990-01-01' })
	await expect(caps.writeSoul({ name: ' ' })).rejects.toThrow('Name and soul cannot be empty')
})

import { BUILTIN_AVATARS, builtinFaces } from '@justfiles/agent/avatars'
import { avatarDir, SOUL_PATH } from '@justfiles/agent/defaults'
import { memStorage, volume } from '@justfiles/fs'
import { expect, test } from 'vitest'
import { derivedDir, readAgentSoul, readAvatar, watchIdentity } from './identity'

// The shell no longer writes these files — Settings' Agent pane does, in an app frame,
// and another device does through sync. So it watches them instead of being told, which
// is what makes a rename on the phone show up here.

const encode = (text: string) => new TextEncoder().encode(text)
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
const MINE = avatarDir('mine')

async function seeded() {
	const vol = volume(memStorage())
	await vol.mkdir('/system/agents/main', { recursive: true })
	await vol.writeFile(
		SOUL_PATH,
		encode(
			'---\nschema: frieren/agent-soul/v1\nagent_name: Kodama\nseeded: true\n---\n\nYou are Kodama.\n'
		)
	)
	return vol
}

// An avatar with a resting file, and whatever else the case puts beside it.
async function wearing(files: Record<string, Uint8Array>) {
	const vol = await seeded()
	await vol.mkdir(MINE, { recursive: true })
	for (const [path, bytes] of Object.entries(files)) {
		await vol.mkdir(`${MINE}/${path}`.slice(0, `${MINE}/${path}`.lastIndexOf('/')), {
			recursive: true
		})
		await vol.writeFile(`${MINE}/${path}`, bytes)
	}
	return vol
}

// The hash `.gen/<hash>` has to carry for art derived from PNG. Asserted through the reader
// rather than spelled out: what matters is that CURRENT means "derived from this file".
async function hashOf(vol: Awaited<ReturnType<typeof seeded>>) {
	const { hash } = await readAvatar(vol, 'mine')
	if (!hash) throw new Error('an avatar on the volume must have a hash')
	return hash
}

test('a soul written by anyone — this device or another — wakes the shell', async () => {
	const vol = await seeded()
	let fired = 0
	const stop = await watchIdentity(vol, () => {
		fired++
	})
	await vol.writeFile(
		SOUL_PATH,
		encode(
			'---\nschema: frieren/agent-soul/v1\nagent_name: Fern\nagent_gender: female\n---\n\nYou are Fern.\n'
		)
	)
	await flush()
	expect(fired).toBeGreaterThan(0)
	// And the read reflects it: the name to greet by, and no longer seeded.
	const soul = await readAgentSoul(vol)
	expect(soul?.frontmatter.agent_name).toBe('Fern')
	expect(soul?.frontmatter.seeded).toBeUndefined()

	// The avatar is the second half of an identity change, and wearing or installing one is a
	// file event now — a photo landing under `avatars/` is what the shell hears.
	const before = fired
	await vol.mkdir(MINE, { recursive: true })
	await vol.writeFile(`${MINE}/resting.png`, PNG)
	await flush()
	expect(fired).toBeGreaterThan(before)

	// And it stops when the provider unmounts.
	stop()
	const after = fired
	await vol.writeFile(`${MINE}/pleased.png`, PNG)
	await flush()
	expect(fired).toBe(after)
})

test('a built-in comes complete, costs no bytes, and never asks for art', async () => {
	const vol = await seeded()
	const teacher = await readAvatar(vol, 'builtin/teacher')
	expect(teacher.url).toBe(BUILTIN_AVATARS.teacher?.resting)
	expect(teacher.faces.pleased).toBe((await builtinFaces('teacher')).pleased)
	// `hash === null` is what makes generation unreachable for it — no code says so.
	expect(teacher.hash).toBeNull()

	// No ref, an unknown built-in, and an avatar that is not on this device: the default,
	// never a hole where a face goes.
	const fallback = await readAvatar(vol, undefined)
	expect(fallback.url).toBe(BUILTIN_AVATARS.vanilla?.resting)
	expect((await readAvatar(vol, 'builtin/from-the-future')).url).toBe(fallback.url)
	expect((await readAvatar(vol, 'aurora')).url).toBe(fallback.url)
})

test('authored art wins, art derived from THIS resting file is next, stale art loses', async () => {
	// Authored, and nothing else: the artist's file is the answer and nothing is ever
	// generated for that state.
	const authored = await wearing({ 'resting.png': PNG, 'pleased.png': new Uint8Array([1]) })
	const worn = await readAvatar(authored, 'mine')
	expect(worn.hash).toMatch(/^[0-9a-f]{8}$/)
	expect(worn.faces.pleased).toContain('data:image/png;base64,')
	// Nothing covers the rest, so the shell will ask for them.
	expect(worn.faces.curious).toBeUndefined()

	// Derived from exactly this resting file: used. Derived from art that has been replaced
	// since: invisible, so the lookup misses and the set regenerates.
	const vol = await wearing({ 'resting.png': PNG })
	const hash = await hashOf(vol)
	await vol.mkdir(derivedDir('mine', hash), { recursive: true })
	await vol.writeFile(`${derivedDir('mine', hash)}/curious.png`, new Uint8Array([2]))
	await vol.mkdir(derivedDir('mine', 'deadbeef'), { recursive: true })
	await vol.writeFile(`${derivedDir('mine', 'deadbeef')}/concerned.png`, new Uint8Array([3]))
	const read = await readAvatar(vol, 'mine')
	expect(read.faces.curious).toContain('data:image/png;base64,')
	expect(read.faces.concerned).toBeUndefined()

	// And an authored file beats a derived one for the same state — a lookup order, not a
	// rule anything has to remember.
	await vol.writeFile(`${MINE}/curious.webp`, new Uint8Array([4]))
	const both = await readAvatar(vol, 'mine')
	expect(both.faces.curious).toContain('data:image/webp;base64,')
})

test('an avatar with no resting state is not one yet', async () => {
	// A pack half-written, or a directory a user made by hand: fall back rather than show
	// an agent with no face.
	const vol = await wearing({ 'pleased.png': PNG })
	expect((await readAvatar(vol, 'mine')).url).toBe(BUILTIN_AVATARS.vanilla?.resting)
})

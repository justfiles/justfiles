import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { avatarDir, avatarFaceHash, avatarState } from './agent-defaults.ts'
import { BUILTIN_AVATARS, builtinFaces } from './avatars.ts'
import { EXPRESSIONS } from './expression.ts'

const ART = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'avatars')

describe('the layout', () => {
	test('an avatar is a directory, and the id is its name', () => {
		expect(avatarDir('mine')).toBe('/system/agents/main/avatars/mine')
	})

	test('stem is the state, extension is only the format', () => {
		expect(avatarState('resting.png')).toBe('resting')
		expect(avatarState('pleased.webp')).toBe('pleased')
		// A name with no extension is a state too — nothing here needs one to resolve, and what
		// a file's bytes ARE is answered by `imageType`, never by this.
		expect(avatarState('resting')).toBe('resting')
		expect(avatarState('.gen')).toBe('.gen')
	})

	test('the hash is stable, short, and changes with the bytes', async () => {
		const a = await avatarFaceHash(new Uint8Array([1, 2, 3]))
		const b = await avatarFaceHash(new Uint8Array([1, 2, 3]))
		const c = await avatarFaceHash(new Uint8Array([1, 2, 4]))
		expect(a).toBe(b)
		expect(a).not.toBe(c)
		expect(a).toMatch(/^[0-9a-f]{8}$/)
	})
})

describe('the built-in art', () => {
	// Generated art goes stale silently: adding an emotion to EXPRESSIONS, or an avatar to
	// the ritual, leaves the matrix a file short and the face quietly keeps resting for that
	// tag. A built-in also resolves with `hash === null`, so nothing will ever derive the
	// missing one for it — the set has to arrive complete.
	test.each(Object.keys(BUILTIN_AVATARS))('%s covers every state', async (id) => {
		expect(BUILTIN_AVATARS[id]?.states.sort()).toEqual(['resting', ...EXPRESSIONS].sort())
		expect(BUILTIN_AVATARS[id]?.resting.startsWith('data:image/')).toBe(true)
		// The faces are a tier down, behind a dynamic import — the shell fetches the set it
		// wears and not the others — so `states` is a promise this has to keep.
		const faces = await builtinFaces(id)
		expect(Object.keys(faces).sort()).toEqual([...EXPRESSIONS].sort())
		for (const url of Object.values(faces)) expect(url.startsWith('data:image/')).toBe(true)
	})

	test('an id this build does not have has no faces, and does not throw', async () => {
		expect(await builtinFaces('from-the-future')).toEqual({})
	})

	test('the four the summoning offers are all here', () => {
		expect(Object.keys(BUILTIN_AVATARS).sort()).toEqual([
			'assistant',
			'companion',
			'teacher',
			'vanilla'
		])
	})

	// avatars.ts is baked from avatars/** (`pnpm run avatars` in apps/frieren), because no
	// bundler-agnostic way to import a PNG exists. Two representations, so this keeps them one.
	test('the baked modules are exactly the art on disk', async () => {
		const onDisk = readdirSync(ART, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
		expect(onDisk.sort()).toEqual(Object.keys(BUILTIN_AVATARS).sort())
		for (const id of onDisk) {
			const faces = await builtinFaces(id)
			for (const name of readdirSync(path.join(ART, id)).filter((n) => n.endsWith('.png'))) {
				const state = avatarState(name)
				const baked = state === 'resting' ? BUILTIN_AVATARS[id]?.resting : faces[state]
				const bytes = readFileSync(path.join(ART, id, name))
				// PNG by decision, not by inference: the bundled art is checked in for human
				// review, and the bake only ever reads `*.png`.
				expect(baked, `run \`pnpm run avatars\` in apps/frieren: ${id}/${name} is stale`).toBe(
					`data:image/png;base64,${bytes.toString('base64')}`
				)
			}
		}
	})
})

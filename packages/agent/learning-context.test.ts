import { memStorage, type Volume, volume } from '@justfiles/fs'
import { beforeEach, describe, expect, test } from 'vitest'
import { learningContext } from './learning-context.ts'

const USER = '/system/user.md'
const CORE = '/system/memory/core.md'
const LEARNING = '/system/context/learning.json'

const enc = new TextEncoder()
const dec = new TextDecoder()

const at = (iso: string) => Date.parse(iso)
const DAY = 24 * 60 * 60 * 1000

// A fake text generator whose call count is observable; `reply` produces the
// extraction JSON from the (core.md) prompt.
function fakeGen(reply: (prompt: string) => string) {
	const gen = Object.assign(
		async (_system: string, prompt: string) => {
			gen.calls++
			return reply(prompt)
		},
		{ calls: 0 }
	)
	return gen
}

// A generator that always fails (no active model / model down).
const boom = async () => {
	throw new Error('model down')
}

async function writeFile(vol: Volume, path: string, text: string) {
	const slash = path.lastIndexOf('/')
	if (slash > 0) await vol.mkdir(path.slice(0, slash), { recursive: true })
	await vol.writeFile(path, enc.encode(text))
}

// A learner profile (age is derived from birth_date host-side) plus a memory file.
// `gender` is seeded to prove it never leaks into the fragment.
async function seed(vol: Volume, opts: { user?: string; core?: string } = {}) {
	await writeFile(vol, USER, opts.user ?? '---\nbirth_date: 2015-06-15\ngender: male\n---\n')
	await writeFile(vol, CORE, opts.core ?? 'Loves Minecraft and dinosaurs. Dislikes scary stories.')
}

const GOOD_JSON = JSON.stringify({
	interests: ['Minecraft', 'dinosaurs'],
	avoidTopics: ['scary stories'],
	learningPreferences: ['short explanations']
})

// A fixed "now" inside the profile's lifetime so age (and thus calibration) is stable.
const NOW = () => at('2025-06-20T00:00:00Z')

describe('learningContext.compose', () => {
	let vol: Volume
	beforeEach(() => {
		vol = volume(memStorage())
	})

	test('composes the host fragment from age + projected memory', async () => {
		await seed(vol)
		const fragment = await learningContext({
			volume: vol,
			gen: fakeGen(() => GOOD_JSON),
			now: NOW
		}).compose()
		expect(fragment).toContain('# Learning adaptation')
		expect(fragment).toContain('10 years old')
		// Gender is never injected for educational adaptation (issue #272).
		expect(fragment).not.toMatch(/\b(boy|girl|man|woman|male)\b/)
		expect(fragment).toContain('Known interests: Minecraft, dinosaurs.')
		expect(fragment).toContain('Avoid these example themes: scary stories.')
		expect(fragment).toContain('Preferred explanation styles: short explanations.')
		expect(fragment).toContain('Do not mention or reveal the user profile or remembered facts.')
	})

	test('persists a valid projection under the schema and reuses it (cache hit, no re-gen)', async () => {
		await seed(vol)
		const gen = fakeGen(() => GOOD_JSON)
		await learningContext({ volume: vol, gen, now: NOW }).compose()
		expect(gen.calls).toBe(1)
		const cached = JSON.parse(dec.decode(await vol.readFile(LEARNING)))
		expect(cached.schema).toBe('frieren/context/learning/v1')
		expect(cached.data.interests).toEqual(['Minecraft', 'dinosaurs'])
		// A second call one hour later reuses the cache — the model is not consulted.
		await learningContext({ volume: vol, gen, now: () => NOW() + 3600_000 }).compose()
		expect(gen.calls).toBe(1)
	})

	test('regenerates when the source changes (sourceHash mismatch)', async () => {
		await seed(vol)
		const gen = fakeGen(() => GOOD_JSON)
		await learningContext({ volume: vol, gen, now: NOW }).compose()
		expect(gen.calls).toBe(1)
		await writeFile(vol, CORE, 'Now loves space and rockets.')
		await learningContext({ volume: vol, gen, now: NOW }).compose()
		expect(gen.calls).toBe(2)
	})

	test('regenerates when the cache is older than the 7-day max age', async () => {
		await seed(vol)
		const gen = fakeGen(() => GOOD_JSON)
		await learningContext({ volume: vol, gen, now: NOW }).compose()
		expect(gen.calls).toBe(1)
		await learningContext({ volume: vol, gen, now: () => NOW() + 8 * DAY }).compose()
		expect(gen.calls).toBe(2)
	})

	test('a malformed cache file is ignored and regenerated', async () => {
		await seed(vol)
		await writeFile(vol, LEARNING, 'not json at all {')
		const gen = fakeGen(() => GOOD_JSON)
		const fragment = await learningContext({ volume: vol, gen, now: NOW }).compose()
		expect(gen.calls).toBe(1)
		expect(fragment).toContain('Known interests: Minecraft, dinosaurs.')
	})

	test('sanitizes the projection: caps at 8, truncates, drops non-strings/extra keys', async () => {
		await seed(vol)
		const dirty = JSON.stringify({
			interests: [...Array.from({ length: 12 }, (_, i) => `topic-${i}`), 42, 'x'.repeat(200)],
			avoidTopics: 'not-an-array',
			learningPreferences: [' concrete examples '],
			secretName: 'Alice',
			birthDate: '2015-06-15'
		})
		await learningContext({ volume: vol, gen: fakeGen(() => dirty), now: NOW }).compose()
		const cached = JSON.parse(dec.decode(await vol.readFile(LEARNING)))
		expect(cached.data.interests).toHaveLength(8)
		expect(cached.data.interests.every((s: string) => s.length <= 40)).toBe(true)
		expect(cached.data.avoidTopics).toEqual([])
		expect(cached.data.learningPreferences).toEqual(['concrete examples'])
		// Excluded fields never survive into the cache payload.
		expect(JSON.stringify(cached)).not.toContain('Alice')
		expect(JSON.stringify(cached)).not.toContain('secretName')
	})

	test('stale-while-error: expired cache + regen failure reuses the last projection', async () => {
		await seed(vol)
		await learningContext({ volume: vol, gen: fakeGen(() => GOOD_JSON), now: NOW }).compose()
		// Cache expired but sources UNCHANGED; the model now fails — reuse stale data.
		const fragment = await learningContext({
			volume: vol,
			gen: boom,
			now: () => NOW() + 8 * DAY
		}).compose()
		expect(fragment).toContain('Known interests: Minecraft, dinosaurs.')
	})

	test('source-changed + regen failure drops stale data, degrading to age-only', async () => {
		await seed(vol)
		await learningContext({ volume: vol, gen: fakeGen(() => GOOD_JSON), now: NOW }).compose()
		await writeFile(vol, CORE, 'Completely different interests now.')
		const fragment = await learningContext({ volume: vol, gen: boom, now: NOW }).compose()
		expect(fragment).toContain('10 years old')
		expect(fragment).not.toContain('Known interests')
	})

	test('a failing model degrades to age-only without writing a cache', async () => {
		await seed(vol)
		const fragment = await learningContext({ volume: vol, gen: boom, now: NOW }).compose()
		expect(fragment).toContain('10 years old')
		expect(fragment).not.toContain('Known interests')
		expect(await vol.exists(LEARNING)).toBe(false)
	})

	test('concurrent cold misses regenerate once (single-flight)', async () => {
		await seed(vol)
		let calls = 0
		const gen = async () => {
			calls++
			await new Promise((r) => setTimeout(r, 10))
			return GOOD_JSON
		}
		const lc = learningContext({ volume: vol, gen, now: NOW })
		const [a, b] = await Promise.all([lc.compose(), lc.compose()])
		expect(calls).toBe(1)
		expect(a).toBe(b)
	})

	test('single-flight is keyed by source: a mid-flight source change is not served stale', async () => {
		await seed(vol)
		const lc = learningContext({
			volume: vol,
			// Answer the extraction from whatever core.md currently says, so each
			// distinct source produces distinct interests.
			gen: async (_s: string, prompt: string) => {
				await new Promise((r) => setTimeout(r, 30))
				return JSON.stringify({
					interests: [prompt.includes('space') ? 'space' : 'Minecraft'],
					avoidTopics: [],
					learningPreferences: []
				})
			},
			now: NOW
		})
		const first = lc.compose()
		// Let `first` finish reading the old sources and enter its (slow) regen before
		// the source changes, so the two composes carry genuinely different hashes.
		await new Promise((r) => setTimeout(r, 1))
		await writeFile(vol, CORE, 'Now loves space and rockets.')
		const second = lc.compose()
		const [a, b] = await Promise.all([first, second])
		expect(a).toContain('Minecraft')
		expect(b).toContain('space')
		expect(b).not.toContain('Minecraft')
	})

	test('empty knowledge yields neutral (empty) context', async () => {
		const gen = fakeGen(() => GOOD_JSON)
		const fragment = await learningContext({ volume: vol, gen, now: NOW }).compose()
		expect(fragment).toBe('')
		expect(gen.calls).toBe(0)
	})
})

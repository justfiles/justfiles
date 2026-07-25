import { memStorage, type Volume, volume } from '@justfiles/fs'
import { beforeEach, describe, expect, test } from 'vitest'
import { learningContext } from './learning-context.ts'
import type { LLMText } from './llm.text.ts'

const USER = '/system/user.md'
const CORE = '/system/memory/core.md'
const LEARNING = '/system/context/learning.json'

const enc = new TextEncoder()
const dec = new TextDecoder()

const at = (iso: string) => Date.parse(iso)
const DAY = 24 * 60 * 60 * 1000

// A fake text model whose `gen` counts calls; `reply` produces the extraction JSON.
function fakeText(reply: (prompt: string) => string): LLMText & { calls: number } {
	const self = {
		calls: 0,
		gen: async (_system: string, prompt: string) => {
			self.calls++
			return reply(prompt)
		},
		takeNotes: async () => undefined,
		summarise: async () => ''
	}
	return self
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
		const text = fakeText(() => GOOD_JSON)
		const lc = learningContext({ volume: vol, resolveText: async () => text, now: NOW })
		const fragment = await lc.compose()
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
		const text = fakeText(() => GOOD_JSON)
		const lc = learningContext({ volume: vol, resolveText: async () => text, now: NOW })
		await lc.compose()
		expect(text.calls).toBe(1)
		const cached = JSON.parse(dec.decode(await vol.readFile(LEARNING)))
		expect(cached.schema).toBe('frieren/context/learning/v1')
		expect(cached.data.interests).toEqual(['Minecraft', 'dinosaurs'])
		// A second call one hour later reuses the cache — the model is not consulted.
		const lc2 = learningContext({
			volume: vol,
			resolveText: async () => text,
			now: () => NOW() + 3600_000
		})
		await lc2.compose()
		expect(text.calls).toBe(1)
	})

	test('regenerates when the source changes (sourceHash mismatch)', async () => {
		await seed(vol)
		const text = fakeText(() => GOOD_JSON)
		await learningContext({ volume: vol, resolveText: async () => text, now: NOW }).compose()
		expect(text.calls).toBe(1)
		await writeFile(vol, CORE, 'Now loves space and rockets.')
		await learningContext({ volume: vol, resolveText: async () => text, now: NOW }).compose()
		expect(text.calls).toBe(2)
	})

	test('regenerates when the cache is older than the 7-day max age', async () => {
		await seed(vol)
		const text = fakeText(() => GOOD_JSON)
		await learningContext({ volume: vol, resolveText: async () => text, now: NOW }).compose()
		expect(text.calls).toBe(1)
		await learningContext({
			volume: vol,
			resolveText: async () => text,
			now: () => NOW() + 8 * DAY
		}).compose()
		expect(text.calls).toBe(2)
	})

	test('a malformed cache file is ignored and regenerated', async () => {
		await seed(vol)
		await writeFile(vol, LEARNING, 'not json at all {')
		const text = fakeText(() => GOOD_JSON)
		const fragment = await learningContext({
			volume: vol,
			resolveText: async () => text,
			now: NOW
		}).compose()
		expect(text.calls).toBe(1)
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
		const text = fakeText(() => dirty)
		await learningContext({ volume: vol, resolveText: async () => text, now: NOW }).compose()
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
		const ok = fakeText(() => GOOD_JSON)
		await learningContext({ volume: vol, resolveText: async () => ok, now: NOW }).compose()
		// Cache expired but sources UNCHANGED; the model now fails — reuse stale data.
		const boom: LLMText = {
			gen: async () => {
				throw new Error('model down')
			},
			takeNotes: async () => undefined,
			summarise: async () => ''
		}
		const fragment = await learningContext({
			volume: vol,
			resolveText: async () => boom,
			now: () => NOW() + 8 * DAY
		}).compose()
		expect(fragment).toContain('Known interests: Minecraft, dinosaurs.')
	})

	test('source-changed + regen failure drops stale data, degrading to age-only', async () => {
		await seed(vol)
		const ok = fakeText(() => GOOD_JSON)
		await learningContext({ volume: vol, resolveText: async () => ok, now: NOW }).compose()
		await writeFile(vol, CORE, 'Completely different interests now.')
		const boom: LLMText = {
			gen: async () => {
				throw new Error('model down')
			},
			takeNotes: async () => undefined,
			summarise: async () => ''
		}
		const fragment = await learningContext({
			volume: vol,
			resolveText: async () => boom,
			now: NOW
		}).compose()
		expect(fragment).toContain('10 years old')
		expect(fragment).not.toContain('Known interests')
	})

	test('no text model degrades to age-only without writing a cache', async () => {
		await seed(vol)
		const fragment = await learningContext({
			volume: vol,
			resolveText: async () => undefined,
			now: NOW
		}).compose()
		expect(fragment).toContain('10 years old')
		expect(fragment).not.toContain('Known interests')
		expect(await vol.exists(LEARNING)).toBe(false)
	})

	test('concurrent cold misses regenerate once (single-flight)', async () => {
		await seed(vol)
		let calls = 0
		const text: LLMText = {
			gen: async () => {
				calls++
				await new Promise((r) => setTimeout(r, 10))
				return GOOD_JSON
			},
			takeNotes: async () => undefined,
			summarise: async () => ''
		}
		const lc = learningContext({ volume: vol, resolveText: async () => text, now: NOW })
		const [a, b] = await Promise.all([lc.compose(), lc.compose()])
		expect(calls).toBe(1)
		expect(a).toBe(b)
	})

	test('empty knowledge yields neutral (empty) context', async () => {
		const text = fakeText(() => GOOD_JSON)
		const fragment = await learningContext({
			volume: vol,
			resolveText: async () => text,
			now: NOW
		}).compose()
		expect(fragment).toBe('')
		expect(text.calls).toBe(0)
	})
})

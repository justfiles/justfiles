// Purpose-scoped context projection (issue #272): the ONLY projection today is
// "learning". A projection is a small, host-owned, rebuildable view derived from
// trusted user knowledge (`/system/user.md` + `/system/memory/core.md`) for one
// use. Raw profile/memory never leave the host — this module composes a
// prompt-safe fragment the `ai` capability prepends; the app sees only the
// final model output.
//
// The file `/system/context/learning.json` is a CACHE, never source of truth:
// deleting it is safe, it regenerates lazily. It is reused only while its
// `sourceHash` matches the current sources and it is younger than MAX_AGE_MS;
// otherwise it is regenerated (single-flight) via the credentialed text model.
// All of `compose()` degrades to age-only / neutral context on any failure so a
// projection miss never breaks the calling app.

import type { Volume } from '@justfiles/fs'
import { z } from 'zod'
import { ageCalibration } from './age-calibration.ts'
import type { LLMText } from './llm.text.ts'
import LEARNING_EXTRACTION from './prompts/learning-extraction.md?raw'

export const LEARNING_SCHEMA = 'frieren/context/learning/v1'
const CONTEXT_DIR = '/system/context'
const LEARNING_PATH = `${CONTEXT_DIR}/learning.json`
const PROFILE_PATH = '/system/user.md'
const CORE_PATH = '/system/memory/core.md'

// Reuse a cached projection for at most 7 days even when sources are unchanged.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
// Strict caps on the prompt-safe payload — short labels only.
const MAX_ENTRIES = 8
const MAX_LEN = 40

const Payload = z.object({
	interests: z.array(z.string()),
	avoidTopics: z.array(z.string()),
	learningPreferences: z.array(z.string())
})
type LearningPayload = z.infer<typeof Payload>

const Envelope = z.object({
	schema: z.string(),
	generatedAt: z.string(),
	sourceHash: z.string(),
	data: Payload
})
type LearningContextFile = z.infer<typeof Envelope>

export interface LearningContextDeps {
	volume: Volume
	// The credentialed text model, resolved lazily so a host that binds it per
	// active account (spud) rebuilds nothing here, and so a missing model simply
	// disables regeneration (age-only fallback) instead of throwing.
	resolveText: () => Promise<LLMText | undefined>
	now?: () => number
}

export interface LearningContext {
	// The host-composed "# Learning adaptation" fragment, or '' when neutral.
	// Never throws.
	compose(): Promise<string>
}

export function learningContext(deps: LearningContextDeps): LearningContext {
	const { volume, resolveText } = deps
	const now = deps.now ?? Date.now
	// Per-instance (per-user) single-flight so concurrent cold misses regenerate once.
	let inflight: Promise<LearningContextFile | null> | undefined

	async function readText(path: string): Promise<string> {
		try {
			if (!(await volume.exists(path))) return ''
			return new TextDecoder().decode(await volume.readFile(path))
		} catch {
			return ''
		}
	}

	async function readCache(): Promise<LearningContextFile | null> {
		const raw = await readText(LEARNING_PATH)
		if (!raw) return null
		try {
			const parsed = Envelope.parse(JSON.parse(raw))
			return parsed.schema === LEARNING_SCHEMA ? parsed : null
		} catch {
			return null
		}
	}

	async function writeCache(projection: LearningContextFile): Promise<void> {
		await volume.mkdir(CONTEXT_DIR, { recursive: true })
		const tmp = `${LEARNING_PATH}.tmp`
		await volume.writeFile(tmp, new TextEncoder().encode(JSON.stringify(projection, null, 2)))
		await volume.rename(tmp, LEARNING_PATH)
	}

	// Regenerate the projection from the current sources. `core` is passed so the
	// hash and the extraction see the same bytes. Throws on model/JSON failure so
	// the caller's single-flight can convert it to null (degrade).
	async function regenerate(hash: string, core: string): Promise<LearningContextFile> {
		let data: LearningPayload
		if (!core.trim()) {
			data = { interests: [], avoidTopics: [], learningPreferences: [] }
		} else {
			const text = await resolveText()
			if (!text) throw new Error('no text model')
			data = sanitize(parseJson(await text.gen(LEARNING_EXTRACTION, core)))
		}
		const projection: LearningContextFile = {
			schema: LEARNING_SCHEMA,
			generatedAt: new Date(now()).toISOString(),
			sourceHash: hash,
			data
		}
		await writeCache(projection)
		return projection
	}

	function regenerateOnce(hash: string, core: string): Promise<LearningContextFile | null> {
		if (!inflight) {
			inflight = regenerate(hash, core)
				.catch(() => null)
				.finally(() => {
					inflight = undefined
				})
		}
		return inflight
	}

	async function projectionData(hash: string, core: string): Promise<LearningPayload | null> {
		const cached = await readCache()
		const fresh =
			cached && cached.sourceHash === hash && now() - Date.parse(cached.generatedAt) <= MAX_AGE_MS
		if (fresh && cached) return cached.data
		const regen = await regenerateOnce(hash, core)
		if (regen) return regen.data
		// Stale-while-error: only when the sources are UNCHANGED (expired-only). A
		// hash mismatch means the stale data describes different sources — drop it.
		if (cached && cached.sourceHash === hash) return cached.data
		return null
	}

	async function compose(): Promise<string> {
		try {
			const [userMd, core] = await Promise.all([readText(PROFILE_PATH), readText(CORE_PATH)])
			const hash = await sourceHash(userMd, core)
			const data = await projectionData(hash, core)
			return fragment(ageCalibration(userMd, new Date(now()), { gender: false }), data)
		} catch {
			return ''
		}
	}

	return { compose }
}

// Deterministic hash of the sources (schema-tagged so a schema bump invalidates).
async function sourceHash(userMd: string, core: string): Promise<string> {
	const input = `${LEARNING_SCHEMA}\n${userMd}\n\u0000\n${core}`
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
	return `sha256-${hex}`
}

// First `{ … }` block, tolerant of code fences or stray prose around it.
function parseJson(text: string): unknown {
	const match = text.match(/\{[\s\S]*\}/)
	if (!match) throw new Error('no json in model output')
	return JSON.parse(match[0])
}

function sanitizeList(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	const out: string[] = []
	for (const item of value) {
		if (typeof item !== 'string') continue
		const s = item.trim().slice(0, MAX_LEN)
		if (s) out.push(s)
		if (out.length >= MAX_ENTRIES) break
	}
	return out
}

function sanitize(value: unknown): LearningPayload {
	const o = (value ?? {}) as Record<string, unknown>
	return {
		interests: sanitizeList(o.interests),
		avoidTopics: sanitizeList(o.avoidTopics),
		learningPreferences: sanitizeList(o.learningPreferences)
	}
}

// Compose the prompt-safe fragment. Age calibration comes from the profile
// (birth date is derived host-side, never injected); interests/aversions/
// preferences come from the projection. '' when there is nothing to say.
function fragment(age: string | null, data: LearningPayload | null): string {
	const lines: string[] = []
	if (age) lines.push(age)
	if (data?.interests.length) lines.push(`Known interests: ${data.interests.join(', ')}.`)
	if (data?.avoidTopics.length)
		lines.push(`Avoid these example themes: ${data.avoidTopics.join(', ')}.`)
	if (data?.learningPreferences.length)
		lines.push(`Preferred explanation styles: ${data.learningPreferences.join(', ')}.`)
	if (lines.length === 0) return ''
	if (data?.interests.length)
		lines.push(
			'Use interests selectively when they make an example clearer; do not force them into every example.'
		)
	lines.push('Do not mention or reveal the user profile or remembered facts.')
	return `# Learning adaptation\n\n${lines.join('\n')}`
}

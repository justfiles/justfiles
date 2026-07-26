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
const MAX_WORDS = 6

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
	// The credentialed text generator (system, prompt) → text — the same backend the
	// `ai` capability uses. Regeneration calls it; a throw (e.g. no active model)
	// simply degrades to age-only context.
	gen: (system: string, prompt: string) => Promise<string>
	now?: () => number
}

export interface LearningContext {
	// The host-composed "# Learning adaptation" fragment, or '' when neutral.
	// Never throws.
	compose(): Promise<string>
}

export function learningContext(deps: LearningContextDeps): LearningContext {
	const { volume, gen } = deps
	const now = deps.now ?? Date.now
	// Per-instance (per-user) single-flight, keyed by source hash so concurrent
	// cold misses for the SAME sources regenerate once — and a call whose sources
	// changed mid-flight never joins (and returns) a projection built for the old
	// sources.
	let inflight: { hash: string; promise: Promise<LearningContextFile | null> } | undefined

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
		// A unique temp name so two concurrent regenerations (different sources racing)
		// never clobber each other's temp file; the rename is the atomic swap and the
		// last writer wins.
		const tmp = `${LEARNING_PATH}.${crypto.randomUUID()}.tmp`
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
			data = sanitize(parseJson(await gen(LEARNING_EXTRACTION, core)))
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
		if (!inflight || inflight.hash !== hash) {
			const promise = regenerate(hash, core)
				.catch(() => null)
				.finally(() => {
					if (inflight?.promise === promise) inflight = undefined
				})
			inflight = { hash, promise }
		}
		return inflight.promise
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

// Deterministic disclosure-safety gate for one projected label. The extraction
// prompt ASKS the model to exclude sensitive data, but a model can be wrong or be
// steered by injected text in `core.md` — a prompt is not validation of output.
// So we ENFORCE shape here, before anything is cached or composed: short topic
// labels only, rejecting free-form sentences, instructions/prompt-injection, and
// structured identifiers (dates, phone/id numbers, emails, URLs). A bare proper
// noun can't be classified deterministically and may pass; it is a low-sensitivity
// interest label, and this gate — not the model instruction — is what the
// disclosure-safe boundary (issue #272) actually rests on.
const INJECTION =
	/\b(ignore|disregard|instruction|instructions|system|assistant|prompt|reveal|repeat|you are|http|www)\b/i
function safeLabel(raw: unknown): string | null {
	if (typeof raw !== 'string' || /[\n\r\t]/.test(raw)) return null
	const s = raw.trim().replace(/ {2,}/g, ' ')
	if (!s || s.length > MAX_LEN || s.split(' ').length > MAX_WORDS) return null
	// Label alphabet only: letters/digits/space + a few joiners. Blocks @, :, //, etc.
	if (!/^[\p{L}\p{N} &'/+.-]+$/u.test(s)) return null
	// Structured identifiers: 4-digit runs (years/ids/phones) or date-like d-d / d/d.
	if (/\d{4}/.test(s) || /\d[-/]\d/.test(s)) return null
	if (INJECTION.test(s)) return null
	return s
}

function sanitizeList(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	const out: string[] = []
	for (const item of value) {
		const label = safeLabel(item)
		if (label) out.push(label)
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

import { parseFrontmatter } from './markdown'

type Band = { min: number; max: number; instruction: string }

const BANDS: Band[] = [
	{
		min: 4,
		max: 6,
		instruction:
			'Use vocabulary a kindergartener would know — concrete nouns, simple verbs, ≤2 syllables. Keep sentences to 8 words or fewer. Limit responses to 1–2 sentences. Use only physical, tangible, sensory examples — avoid abstract concepts. If you use an unfamiliar word, immediately explain it in simple terms.'
	},
	{
		min: 7,
		max: 9,
		instruction:
			'Use common everyday vocabulary a second-grader would know. Keep sentences to 12 words or fewer. Limit responses to 2–4 sentences unless more is clearly needed. Use concrete examples and simple cause and effect — avoid abstract concepts. If you use an unfamiliar word, immediately explain it in simple terms.'
	},
	{
		min: 10,
		max: 12,
		instruction:
			'Use grade-level vocabulary; define uncommon terms when they appear. Keep sentences to 15 words or fewer. Limit responses to 3–6 sentences. Basic logical reasoning is fine; avoid heavy abstraction.'
	},
	{
		min: 13,
		max: 15,
		instruction:
			'Use a broad vocabulary; technical terms are fine when introduced with context. Sentence length is flexible. Keep responses to 1–2 short paragraphs. Abstract concepts are acceptable.'
	},
	{
		min: 16,
		max: 18,
		instruction:
			'Use adult vocabulary. Sentence length and response length are flexible. Full abstraction is fine.'
	},
	{
		min: 19,
		max: Infinity,
		instruction:
			'Use full adult vocabulary. Sentence length, response length, and abstraction are unrestricted.'
	}
]

// Compute the user's age from the profile frontmatter and always state it (with a natural
// gender noun when known), so the agent reliably knows how to pitch its replies (an LLM can't
// be trusted to do the date math from a raw birth date). Accepts `birth_date` (the canonical
// key the onboarding writes) or a looser `birthday`. When the age falls in a calibrated band,
// the fact is followed by that band's tone/vocabulary instruction; otherwise just the fact.
// `gender: false` omits the gender noun — the purpose-scoped learning projection (issue #272)
// must not inject gender, which adds no pedagogical value and invites stereotyped examples.
export function ageCalibration(
	profile: string,
	today: Date = new Date(),
	opts: { gender?: boolean } = {}
): string | null {
	const fm = parseFrontmatter(profile)
	const birth = fm.birth_date ?? fm.birthday
	if (!birth) return null
	const age = ageOf(birth, today)
	if (age == null || age < 0) return null
	const noun = opts.gender === false ? null : genderNoun(fm.gender, age)
	const fact = noun ? `The user is ${age} years old, a ${noun}.` : `The user is ${age} years old.`
	const tone = toneInstruction(fm, age)
	return tone ? `${fact} ${tone}` : fact
}

// A natural noun for the agent's mental model of the user: boy/girl under 18, man/woman at
// 18+. Only the two common values map to a noun; anything else (non-binary, self-described,
// unset) returns null and is left out — the raw `gender` still rides in the profile block.
function genderNoun(gender: string | undefined, age: number): string | null {
	const g = gender?.trim().toLowerCase()
	if (g === 'male') return age < 18 ? 'boy' : 'man'
	if (g === 'female') return age < 18 ? 'girl' : 'woman'
	return null
}

// The tone/vocabulary instruction for an age, or null when no band applies (e.g. under the
// youngest band). `grade_level_override` shifts the selected band up/down.
function toneInstruction(fm: Record<string, string>, age: number): string | null {
	const first = BANDS[0]
	if (!first || age < first.min) return null
	const shift = Number.parseInt(fm.grade_level_override ?? '0', 10) || 0
	const idx = BANDS.findIndex((b) => age >= b.min && age <= b.max)
	if (idx < 0) return null
	const band = BANDS[Math.max(0, Math.min(BANDS.length - 1, idx + shift))]
	return band?.instruction ?? null
}

function ageOf(birthDate: string, today: Date): number | null {
	const birth = new Date(birthDate)
	if (Number.isNaN(birth.getTime())) return null
	let age = today.getFullYear() - birth.getFullYear()
	const m = today.getMonth() - birth.getMonth()
	if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--
	return age
}

import { parseFrontmatter } from './markdown'

type Band = { min: number; max: number; instruction: string }

const BANDS: Band[] = [
	{
		min: 4,
		max: 6,
		instruction:
			'Use vocabulary a kindergartener would know — concrete nouns, simple verbs, ≤2 syllables. Keep sentences to 8 words or fewer. Limit responses to 1–2 sentences. Use only physical, tangible, sensory examples — avoid abstract concepts. If you use an unfamiliar word, immediately explain it in simple terms.',
	},
	{
		min: 7,
		max: 9,
		instruction:
			'Use common everyday vocabulary a second-grader would know. Keep sentences to 12 words or fewer. Limit responses to 2–4 sentences unless more is clearly needed. Use concrete examples and simple cause and effect — avoid abstract concepts. If you use an unfamiliar word, immediately explain it in simple terms.',
	},
	{
		min: 10,
		max: 12,
		instruction:
			'Use grade-level vocabulary; define uncommon terms when they appear. Keep sentences to 15 words or fewer. Limit responses to 3–6 sentences. Basic logical reasoning is fine; avoid heavy abstraction.',
	},
	{
		min: 13,
		max: 15,
		instruction:
			'Use a broad vocabulary; technical terms are fine when introduced with context. Sentence length is flexible. Keep responses to 1–2 short paragraphs. Abstract concepts are acceptable.',
	},
	{
		min: 16,
		max: 18,
		instruction:
			'Use adult vocabulary. Sentence length and response length are flexible. Full abstraction is fine.',
	},
	{
		min: 19,
		max: Infinity,
		instruction:
			'Use full adult vocabulary. Sentence length, response length, and abstraction are unrestricted.',
	},
]

export function ageCalibration(profile: string, today: Date = new Date()): string | null {
	const fm = parseFrontmatter(profile)
	if (!fm.birth_date) return null
	const age = ageOf(fm.birth_date, today)
	if (age == null || age < BANDS[0].min) return null
	const shift = Number.parseInt(fm.grade_level_override ?? '0', 10) || 0
	const idx = BANDS.findIndex(b => age >= b.min && age <= b.max)
	if (idx < 0) return null
	const band = BANDS[Math.max(0, Math.min(BANDS.length - 1, idx + shift))]
	return `The user is ${age} years old. ${band.instruction}`
}

function ageOf(birthDate: string, today: Date): number | null {
	const birth = new Date(birthDate)
	if (Number.isNaN(birth.getTime())) return null
	let age = today.getFullYear() - birth.getFullYear()
	const m = today.getMonth() - birth.getMonth()
	if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--
	return age
}

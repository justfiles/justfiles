// The expression channel: the agent prefixes each sentence of a reply with one bracket
// tag (`[pleased]`), a host strips the tags before display and maps the latest one to an
// avatar face. Same shape ChatVRM/Amica/Open-LLM-VTuber use — it streams (the tag arrives
// before its sentence) and degrades to harmless text if the model ignores the contract.
//
// Deliberately dependency-free: the browser imports this to strip live token deltas, the
// worker to strip replayed history. Import from `@justfiles/agent/expression`.

export const EXPRESSIONS = [
	'neutral',
	'thinking',
	'pleased',
	'curious',
	'concerned',
	'apologetic'
] as const

export type Expression = (typeof EXPRESSIONS)[number]

const KNOWN: ReadonlySet<string> = new Set(EXPRESSIONS)
const LONGEST = Math.max(...EXPRESSIONS.map((name) => name.length))

// The system-prompt contract. The examples carry more weight than the rule — a small model
// copies the shape it has seen. Added by `createAgentSession({ expressions: true })`.
export const EXPRESSION_PROMPT = [
	'Prefix each sentence of your reply with exactly one expression tag:',
	EXPRESSIONS.map((name) => `[${name}]`).join(' '),
	'',
	'[pleased]Found it. [neutral]The worker was missing the KV binding.',
	'[concerned]That would drop the table. [curious]Want me to dump it first?',
	'[apologetic]That failed twice. [thinking]Let me try the other path.',
	'',
	'The tag is markup, not speech: never mention it, never announce or describe your',
	'feelings in prose, and never invent a tag outside the list. Omit the tag to continue',
	'the previous one. Tags open a sentence only — never inside code, paths or links.'
].join('\n')

// One face's art direction. The image model is an editor: it gets `avatar.png` plus this
// instruction, and must return the SAME character with a different expression. Framing and
// palette have to be pinned or the six faces drift into six characters (probed against
// google/gemini-3.1-flash-image — see scripts/probe-faces.mjs).
const FACE_DIRECTION: Record<Expression, string> = {
	neutral: 'a calm, neutral expression: relaxed brows, mouth closed and level',
	thinking: 'a thinking expression: eyes looking up and away, mouth a small flat line',
	pleased: 'a pleased expression: a warm closed-mouth smile, eyes softly narrowed',
	curious: 'a curious expression: one brow raised, eyes wide, mouth slightly open',
	concerned: 'a concerned expression: brows drawn slightly together, mouth neutral-tense',
	apologetic: 'an apologetic expression: eyes lowered, brows raised inward, a small closed mouth'
}

export function facePrompt(expression: Expression): string {
	return [
		`Change only the facial expression to ${FACE_DIRECTION[expression]}.`,
		'Keep the same character, art style, colours, lighting, framing, crop and background.',
		'Do not change identity, hair, clothing or composition.',
		'Output one square image.'
	].join(' ')
}

export interface ExpressionParser {
	// Feed a token delta; returns the text to render plus every tag seen in it, in order —
	// a fast stream can carry several sentences (so several tags) in one chunk. An
	// unterminated tag at the tail is held back until the next delta completes it.
	push(delta: string): { text: string; expressions: Expression[] }
	// Release whatever is still held (end of message) — an incomplete tag was just text.
	flush(): string
}

export function createExpressionParser(): ExpressionParser {
	// Text withheld because it may still turn out to be a tag.
	let carry = ''
	// A stripped tag swallows the single space that separated it from its sentence.
	let skipSpace = false

	return { push, flush }

	function push(delta: string): { text: string; expressions: Expression[] } {
		carry += delta
		let text = ''
		const expressions: Expression[] = []

		for (;;) {
			const open = carry.indexOf('[')
			if (open === -1) {
				text += emit(carry)
				carry = ''
				break
			}
			text += emit(carry.slice(0, open))
			carry = carry.slice(open)

			const close = carry.indexOf(']')
			if (close === -1) {
				// Still open: hold it only while it could become a tag, so a markdown link
				// or a stray bracket is not stuck behind an unterminated guess.
				if (isTagPrefix(carry)) break
				text += emit(carry)
				carry = ''
				break
			}

			const raw = carry.slice(0, close + 1)
			carry = carry.slice(close + 1)
			const tag = raw.slice(1, -1).toLowerCase()
			if (KNOWN.has(tag)) {
				expressions.push(tag as Expression)
				skipSpace = true
			} else {
				// Not ours (a markdown link label, a literal bracket) — pass it through verbatim.
				text += raw
			}
		}

		return { text, expressions }
	}

	function flush(): string {
		const rest = emit(carry)
		carry = ''
		return rest
	}

	function emit(chunk: string): string {
		if (!skipSpace || chunk === '') return chunk
		skipSpace = false
		return chunk.startsWith(' ') ? chunk.slice(1) : chunk
	}
}

// One-shot strip for a complete message (history replay, a notification body).
export function stripExpressions(text: string): {
	text: string
	expressions: Expression[]
} {
	const parser = createExpressionParser()
	const { text: head, expressions } = parser.push(text)
	return { text: head + parser.flush(), expressions }
}

function isTagPrefix(carry: string): boolean {
	const body = carry.slice(1)
	if (body.length > LONGEST || !/^[a-zA-Z]*$/.test(body)) return false
	const lower = body.toLowerCase()
	return EXPRESSIONS.some((name) => name.startsWith(lower))
}

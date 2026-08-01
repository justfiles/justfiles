// The expression channel: the agent prefixes a sentence of a reply with one bracket tag
// (`[pleased]`) when the feeling changes, a host strips the tags before display and maps the
// latest one to an avatar face. Same shape ChatVRM/Amica/Open-LLM-VTuber use — it streams (the
// tag arrives before its sentence) and degrades to harmless text if the model ignores the
// contract.
//
// There is deliberately no tag for calm: it is the state the face returns to on its own — when
// a turn opens, when a held emotion times out, and (once mood lands) by gravitating there — so
// the vocabulary is emotions only. A model that sends `[neutral]` anyway is a model inventing a
// tag, and it prints as text like any other invention; that is loud enough to notice and cheap
// enough to fix if it turns out to happen.
//
// Deliberately dependency-free: the browser imports this to strip live token deltas, the
// worker to strip replayed history. Import from `@justfiles/agent/expression`.

export const EXPRESSIONS = ['thinking', 'pleased', 'curious', 'concerned', 'apologetic'] as const

export type Expression = (typeof EXPRESSIONS)[number]

const KNOWN: ReadonlySet<string> = new Set<string>(EXPRESSIONS)
const LONGEST = Math.max(...EXPRESSIONS.map((name) => name.length))

// The system-prompt contract. The examples carry more weight than the rule — a small model
// copies the shape it has seen. Added by `createAgentSession({ expressions: true })`.
export const EXPRESSION_PROMPT = [
	'Prefix a sentence with an expression tag when the feeling changes:',
	EXPRESSIONS.map((name) => `[${name}]`).join(' '),
	'',
	'[pleased]Found it. The worker was missing the KV binding.',
	'[concerned]That would drop the table. [curious]Want me to dump it first?',
	'[apologetic]That failed twice. [thinking]Let me try the other path.',
	'',
	'The tag is markup, not speech: never mention it, never announce or describe your',
	'feelings in prose, and never invent a tag outside the list. Omit the tag to continue',
	'the previous one. Tags open a sentence only — never inside code, paths or links.',
	'There is no tag for calm and none is needed: leave a plain sentence untagged and the',
	'face settles by itself.',
	'If you have to write a tag as an EXAMPLE rather than use it, put it in backticks',
	'(`[pleased]`) so it survives as text.'
].join('\n')

// One face's art direction. The image model is an editor: it gets the avatar's resting art
// (`avatars/<id>/resting.*`) plus this instruction, and must return the SAME character with a
// different expression. Framing and palette have to be pinned or the six faces drift into six
// characters (probed against
// google/gemini-3.1-flash-image — see scripts/probe-faces.mjs).
const FACE_DIRECTION: Record<Expression, string> = {
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
		// Without this an editor re-draws a feature in its own idiom rather than the art's — a
		// solid pupil comes back as an outlined ring, a carried object changes shape — which is
		// invisible in one image and reads as a glitch across a set that swaps in place.
		'Redraw each feature in the style it is already drawn in: the same line weight, the same fills and highlights.',
		'Anything the character wears or carries stays exactly as it is.',
		'Output one square image.'
	].join(' ')
}

export interface ExpressionParser {
	// Feed a token delta; returns the text to render plus the last emotion seen in it (a chunk
	// can carry several sentences — the newest tag is the one the face shows). An unterminated
	// tag at the tail is held back until the next delta completes it.
	push(delta: string): { text: string; expression: Expression | null }
	// Release whatever is still held (end of message) — an incomplete tag was just text.
	flush(): string
}

export function createExpressionParser(): ExpressionParser {
	// Text withheld because it may still turn out to be a tag.
	let carry = ''
	// A stripped tag swallows the single space that separated it from its sentence.
	let skipSpace = false
	// The tail of what the reader has already been handed, which is all that decides whether
	// a bracket is markup: a tag OPENS a sentence, so a bracket anywhere else is prose and
	// must survive verbatim (`` `[neutral]` is the literal value ``, or an agent explaining
	// "I use [pleased] when things go well"). Shredding a reply is worse than a missed face.
	// Seeded with a newline: the message starts on a fresh line.
	let tail = '\n'

	return { push, flush }

	function push(delta: string): { text: string; expression: Expression | null } {
		carry += delta
		let text = ''
		let expression: Expression | null = null

		for (;;) {
			const open = carry.indexOf('[')
			if (open === -1) {
				text += emit(carry)
				carry = ''
				break
			}
			text += emit(carry.slice(0, open))
			// Read the position BEFORE the bracket is consumed — `emit` has just moved `tail`.
			const opens = opensSentence()
			carry = carry.slice(open)

			const close = carry.indexOf(']')
			if (close === -1) {
				// Still open: hold it only while it could become a tag, so a markdown link
				// or a stray bracket is not stuck behind an unterminated guess.
				if (opens && isTagPrefix(carry)) break
				text += emit(carry)
				carry = ''
				break
			}

			const raw = carry.slice(0, close + 1)
			const rest = carry.slice(close + 1)
			const name = raw.slice(1, -1).toLowerCase()
			if (opens && KNOWN.has(name)) {
				// `[thinking]` and `[thinking](url)` differ only in the character after `]`, so a
				// tag needs one character of lookahead: hold until the next delta brings it.
				if (rest === '') break
				if (rest[0] !== '(') {
					carry = rest
					expression = name as Expression
					skipSpace = true
					// A stripped tag leaves the position as open as a fresh line, so `[a][b]` works.
					tail = '\n'
					continue
				}
			}
			// Not ours (a markdown link, a literal bracket, prose) — pass it through verbatim.
			carry = rest
			text += emit(raw)
		}

		return { text, expression }
	}

	function flush(): string {
		// A message ending on a bare tag has no sentence for it: drop the markup rather than
		// print it. Anything else that is still held was never a tag, so it was always text.
		const held = carry
		const wasTag = opensSentence() && KNOWN.has(held.slice(1, -1).toLowerCase())
		carry = ''
		return wasTag && held.endsWith(']') ? '' : emit(held)
	}

	function opensSentence(): boolean {
		return LINE_START.test(tail) || AFTER_SENTENCE.test(tail)
	}

	function emit(chunk: string): string {
		const out = skipSpace && chunk.startsWith(' ') ? chunk.slice(1) : chunk
		if (chunk !== '') skipSpace = false
		if (out !== '') tail = (tail + out).slice(-TAIL)
		return out
	}
}

// Where a tag may open a sentence. Nothing but whitespace and markdown line markers since
// the last newline — a bullet, a quote, a heading all still open a line — or a finished
// sentence and its space. Generous on purpose: leaking a real tag as visible `[pleased]`
// text is worse than keeping a bracket the model never meant as markup, so a closing quote
// and markdown emphasis count as sentence enders too.
const LINE_START = /[\n\r][\t >*+#-]*$/
const AFTER_SENTENCE = /[.!?…:;)\]"'”’*_][ \t]+$/
// Enough tail to see the longest line prefix; the rules never look further back.
const TAIL = 16

// One-shot strip for a complete message (history replay, a notification body).
export function stripExpressions(text: string): {
	text: string
	expression: Expression | null
} {
	const parser = createExpressionParser()
	const { text: head, expression } = parser.push(text)
	return { text: head + parser.flush(), expression }
}

function isTagPrefix(carry: string): boolean {
	const body = carry.slice(1)
	if (body.length > LONGEST || !/^[a-zA-Z]*$/.test(body)) return false
	const lower = body.toLowerCase()
	return EXPRESSIONS.some((name) => name.startsWith(lower))
}

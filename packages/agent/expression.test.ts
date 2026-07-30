import { describe, expect, test } from 'vitest'
import { createExpressionParser, EXPRESSION_PROMPT, stripExpressions } from './expression.ts'

// Feed a reply one chunk at a time (as the token stream does) and collect the result.
function stream(chunks: string[]) {
	const parser = createExpressionParser()
	let text = ''
	const seen: string[] = []
	for (const chunk of chunks) {
		const out = parser.push(chunk)
		text += out.text
		if (out.expression) seen.push(out.expression)
	}
	return { text: text + parser.flush(), seen }
}

describe('stripExpressions', () => {
	test('pulls the tag out and keeps the sentence', () => {
		expect(stripExpressions('[pleased]Found it.')).toEqual({
			text: 'Found it.',
			expression: 'pleased'
		})
	})

	test('swallows the single separating space, not the sentence spacing', () => {
		expect(stripExpressions('[pleased] Found it.  Twice.').text).toBe('Found it.  Twice.')
	})

	test('reports the last tag of a multi-sentence reply — last tag wins', () => {
		const out = stripExpressions('[pleased]Found it. [concerned]But the table is gone.')
		expect(out).toEqual({ text: 'Found it. But the table is gone.', expression: 'concerned' })
	})

	test('leaves markdown links and unknown brackets alone', () => {
		const text = 'See [the docs](https://x.dev) and [whatever] else.'
		expect(stripExpressions(text)).toEqual({ text, expression: null })
	})

	test('is case-insensitive (small models drift on casing)', () => {
		expect(stripExpressions('[Pleased]hi').expression).toBe('pleased')
	})

	test('a reply with no tags is untouched', () => {
		expect(stripExpressions('plain text')).toEqual({ text: 'plain text', expression: null })
	})

	// A tag OPENS a sentence. Everything below is a mood word in a position the contract
	// never uses, so it is prose the reader must see verbatim — mangled text is far worse
	// than a missed face.
	test('a mood word inside code or mid-sentence is prose, not a tag', () => {
		const code = 'The tag `[neutral]` is the literal value.'
		expect(stripExpressions(code)).toEqual({ text: code, expression: null })
		const mid = 'I wrote [pleased] on the form.'
		expect(stripExpressions(mid)).toEqual({ text: mid, expression: null })
		// The agent explaining its own vocabulary is the case most likely to hit this.
		const about = 'I use [pleased] when things go well.'
		expect(stripExpressions(about)).toEqual({ text: about, expression: null })
	})

	test('a tag still opens a sentence after punctuation or a line break', () => {
		expect(stripExpressions('Done! [curious]Why?')).toEqual({
			text: 'Done! Why?',
			expression: 'curious'
		})
		expect(stripExpressions('- one\n[pleased]Two.')).toEqual({
			text: '- one\nTwo.',
			expression: 'pleased'
		})
	})

	// Markdown markers still open a line, and a leaked `[pleased]` in a bulleted reply is
	// exactly the visible junk this is all here to prevent.
	test('a tag opens a sentence after a bullet, a quote or a heading', () => {
		expect(stripExpressions('- [pleased]Done.\n- [concerned]Not that one.')).toEqual({
			text: '- Done.\n- Not that one.',
			expression: 'concerned'
		})
		expect(stripExpressions('> [apologetic]My mistake.').text).toBe('> My mistake.')
		expect(stripExpressions('## [thinking]The plan').text).toBe('## The plan')
		expect(stripExpressions('1. [pleased]First').text).toBe('1. First')
		expect(stripExpressions('  * [curious]Nested?').text).toBe('  * Nested?')
	})

	test('a markdown link whose label is a mood word survives', () => {
		const text = '[thinking](https://x.dev) is worth a read.'
		expect(stripExpressions(text)).toEqual({ text, expression: null })
	})

	test('a trailing bare tag is dropped, not printed', () => {
		expect(stripExpressions('Found it. [pleased]')).toEqual({
			text: 'Found it. ',
			expression: null
		})
	})
})

describe('streaming', () => {
	test('a tag split across deltas is not rendered', () => {
		expect(stream(['[ple', 'ased]Fou', 'nd it.'])).toEqual({
			text: 'Found it.',
			seen: ['pleased']
		})
	})

	test('the space after a split tag is still swallowed', () => {
		expect(stream(['[pleased]', ' Found it.']).text).toBe('Found it.')
	})

	test('a bracket that cannot become a tag is released immediately', () => {
		expect(stream(['run [x', ' 1] now']).text).toBe('run [x 1] now')
	})

	test('an unterminated tag at the end of a message is plain text', () => {
		expect(stream(['done [conc']).text).toBe('done [conc')
	})

	test('one tag per delta is observed, in order', () => {
		expect(stream(['[thinking]a. ', '[pleased]b. ', '[concerned]c.']).seen).toEqual([
			'thinking',
			'pleased',
			'concerned'
		])
	})

	// There is no tag for calm, so `[neutral]` is not markup any more — it is a tag the agent
	// invented, and an invented tag is prose. Pinned because it is a deliberate trade: shredding
	// a reply to hide a model's slip is worse than letting the slip show, and a bracket word in
	// the transcript is loud enough that we would notice within a session.
	test('a tag outside the vocabulary stays as prose', () => {
		expect(stream(['[pleased]Haha, nice one. ', '[neutral]That was a good setup.'])).toEqual({
			text: 'Haha, nice one. [neutral]That was a good setup.',
			seen: ['pleased']
		})
	})

	// The tag/link lookahead must not depend on where the stream happens to break.
	test('a delta ending exactly on `]` resolves on the next one', () => {
		expect(stream(['[pleased]', 'Found it.'])).toEqual({ text: 'Found it.', seen: ['pleased'] })
		expect(stream(['[pleased]', '(https://x.dev) is good.']).text).toBe(
			'[pleased](https://x.dev) is good.'
		)
	})
})

test('the prompt lists every expression, and offers no tag for calm', () => {
	expect(EXPRESSION_PROMPT).toContain('[apologetic]')
	expect(EXPRESSION_PROMPT).not.toContain('[neutral]')
})

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
		seen.push(...out.expressions)
	}
	return { text: text + parser.flush(), seen }
}

describe('stripExpressions', () => {
	test('pulls the tag out and keeps the sentence', () => {
		expect(stripExpressions('[pleased]Found it.')).toEqual({
			text: 'Found it.',
			expressions: ['pleased']
		})
	})

	test('swallows the single separating space, not the sentence spacing', () => {
		expect(stripExpressions('[pleased] Found it.  Twice.').text).toBe('Found it.  Twice.')
	})

	test('reports every tag of a multi-sentence reply, in order', () => {
		const out = stripExpressions('[pleased]Found it. [concerned]But the table is gone.')
		expect(out).toEqual({
			text: 'Found it. But the table is gone.',
			expressions: ['pleased', 'concerned']
		})
	})

	test('leaves markdown links and unknown brackets alone', () => {
		const text = 'See [the docs](https://x.dev) and [whatever] else.'
		expect(stripExpressions(text)).toEqual({ text, expressions: [] })
	})

	test('is case-insensitive (small models drift on casing)', () => {
		expect(stripExpressions('[Pleased]hi').expressions).toEqual(['pleased'])
	})

	test('a reply with no tags is untouched', () => {
		expect(stripExpressions('plain text')).toEqual({ text: 'plain text', expressions: [] })
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

	test('every tag in the stream is observed in order', () => {
		expect(stream(['[thinking]a. ', '[pleased]b. ', '[neutral]c.']).seen).toEqual([
			'thinking',
			'pleased',
			'neutral'
		])
	})
})

test('the prompt lists every expression', () => {
	expect(EXPRESSION_PROMPT).toContain('[apologetic]')
	expect(EXPRESSION_PROMPT).toContain('[neutral]')
})

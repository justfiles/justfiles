import type { TranscriptEntry } from '@justfiles/ghost'
import { describe, expect, it } from 'vitest'
import { html, withHtml } from './html.ts'

describe('html', () => {
	it('converts GitHub Markdown, escaping raw HTML', () => {
		expect(html('| a | b |\n|---|--:|\n| **1** | 2 |\n\n<script>x</script>')).toBe(
			'<table>\n<thead>\n<tr>\n<th>a</th>\n<th align="right">b</th>\n</tr>\n</thead>\n' +
				'<tbody>\n<tr>\n<td><strong>1</strong></td>\n<td align="right">2</td>\n</tr>\n' +
				'</tbody>\n</table>\n&lt;script&gt;x&lt;/script&gt;'
		)
	})
})

describe('withHtml', () => {
	const answer: TranscriptEntry = { id: 2, kind: 'assistant', text: '*hi*', toolCalls: [] }
	const ask: TranscriptEntry = { id: 1, kind: 'user', text: '*hi*' }

	it('adds html to answers, in entries and snapshots, and leaves other entries alone', () => {
		expect(withHtml({ type: 'entry', entry: answer })).toEqual({
			type: 'entry',
			entry: { ...answer, html: '<p><em>hi</em></p>' }
		})
		expect(
			withHtml({
				type: 'snapshot',
				transcript: { entries: [ask, answer] },
				status: { busy: false, queued: 0 }
			} as never)
		).toMatchObject({
			transcript: { entries: [ask, { ...answer, html: '<p><em>hi</em></p>' }] }
		})
	})

	it('adds html to a quick answer, and passes other replies through', () => {
		expect(withHtml({ type: 'quick', text: '`x`' })).toEqual({
			type: 'quick',
			text: '`x`',
			html: '<p><code>x</code></p>'
		})
		const text = { type: 'text', delta: '*h' } as const
		expect(withHtml(text)).toBe(text)
	})
})

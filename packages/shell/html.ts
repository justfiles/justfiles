import type { TranscriptEntry } from '@justfiles/ghost'
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import type { Reply } from './protocol.ts'

/**
 * Markdown as HTML: CommonMark with GitHub's tables, task lists, strikethrough and autolinks.
 * Raw HTML in it is escaped and unsafe link protocols are dropped, micromark's defaults.
 */
export function html(markdown: string): string {
	return micromark(markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()] })
}

/** `reply` with an `html` beside the text of each answer in it, for a client that draws HTML. */
export function withHtml(reply: Reply): object {
	switch (reply.type) {
		case 'snapshot':
			return {
				...reply,
				transcript: { ...reply.transcript, entries: reply.transcript.entries.map(entry) }
			}
		case 'entry':
			return { ...reply, entry: entry(reply.entry) }
		case 'quick':
			return { ...reply, html: html(reply.text) }
	}
	return reply
}

function entry(entry: TranscriptEntry): object {
	return entry.kind === 'assistant' ? { ...entry, html: html(entry.text) } : entry
}

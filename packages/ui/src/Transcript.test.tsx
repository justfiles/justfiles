import type { TranscriptItem } from '@justfiles/agent/protocol'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Transcript } from './Transcript'

const activity = (failed = false): Extract<TranscriptItem, { type: 'activity' }> => ({
	id: 'activity',
	type: 'activity',
	label: '2 steps · 1.4s',
	items: [
		{ kind: 'think', durationMs: 400 },
		{ kind: 'tool', name: 'read', label: 'Reading Transcript.tsx', durationMs: 1_000 }
	],
	...(failed ? { failed: true as const } : {}),
	detailId: 'detail'
})

describe('Transcript activity creases', () => {
	it('keeps settled activity in chronological order and folded by default', () => {
		const html = renderToStaticMarkup(
			<Transcript
				messages={[
					{ id: 'user', type: 'message', role: 'user', content: 'Run it' },
					activity(),
					{ id: 'reply', type: 'message', role: 'assistant', content: 'Done' }
				]}
				isStreaming={false}
			/>
		)

		expect(html.indexOf('Run it')).toBeLessThan(html.indexOf('2 steps · 1.4s'))
		expect(html.indexOf('2 steps · 1.4s')).toBeLessThan(html.indexOf('Done'))
		expect(html).toContain('data-open="false"')
		expect(html).toContain('aria-expanded="false"')
		expect(html).toContain('aria-hidden="true"')
		expect(html).toContain('inert=""')
	})

	it('opens failed runs without loading during render', () => {
		const loadDetail = vi.fn()
		const failed = renderToStaticMarkup(
			<Transcript messages={[activity(true)]} isStreaming={false} activity={{ loadDetail }} />
		)

		expect(failed).toContain('data-open="true" data-failed="true"')
		expect(loadDetail).not.toHaveBeenCalled()
	})

	it('renders no crease for a plain answer', () => {
		const html = renderToStaticMarkup(
			<Transcript
				messages={[{ id: 'reply', type: 'message', role: 'assistant', content: 'Done' }]}
				isStreaming={false}
			/>
		)

		expect(html).not.toContain('<div class="js-transcript-crease"')
	})
})

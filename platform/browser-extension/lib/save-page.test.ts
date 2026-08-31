import { describe, expect, it, vi } from 'vitest'
import { activePage, createSavePage } from './save-page.ts'

describe('save page', () => {
	it.each([
		'http://example.com/a',
		'https://example.com/a'
	])('accepts a supported page: %s', (url) => {
		expect(activePage({ url, title: 'Example' })).toMatchObject({
			title: 'Example',
			host: 'example.com'
		})
	})

	it('passes the active tab URL through without normalising it', () => {
		expect(activePage({ url: 'https://example.com' })?.url).toBe('https://example.com')
	})

	it.each([
		undefined,
		'',
		'chrome://extensions',
		'file:///tmp/a',
		'not a URL'
	])('rejects an unsupported page: %s', (url) => {
		expect(activePage({ url })).toBeUndefined()
	})

	it('maps the command to Read exactly', async () => {
		const run = vi.fn().mockResolvedValue({ saved: true })
		const savePage = createSavePage(run)

		await savePage('https://example.com/article')

		expect(run).toHaveBeenCalledWith('justfiles.read', 'save', {
			input: 'https://example.com/article'
		})
	})

	it('ignores another save while one is in flight', async () => {
		let finish: (() => void) | undefined
		const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
		const savePage = createSavePage(run)

		const first = savePage('https://example.com/first')
		await savePage('https://example.com/second')
		expect(run).toHaveBeenCalledOnce()
		finish?.()
		await first
	})
})

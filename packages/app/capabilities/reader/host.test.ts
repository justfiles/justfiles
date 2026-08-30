import { expect, test, vi } from 'vitest'
import { readerHost } from './host.ts'

const long = Array.from({ length: 50 }, (_, index) => `word${index}`).join(' ')

function call(host: ReturnType<typeof readerHost>, url = 'https://example.com/article#section') {
	return host.invoke({
		appId: 'test.reader',
		capability: 'reader',
		method: 'read',
		scopes: [],
		args: [{ url }]
	})
}

test('reads Markdown and metadata from readable.page', async () => {
	const fetcher = vi.fn(
		async () =>
			new Response(
				`---\ntitle: Readable title\nsiteName: Example\nauthor: Ada\ndate: 2026-08-30\n---\n\n${long}`,
				{ headers: { 'content-type': 'text/markdown' } }
			)
	)
	const host = readerHost({ fetch: fetcher })

	await expect(call(host)).resolves.toEqual({
		url: 'https://example.com/article',
		title: 'Readable title',
		markdown: long,
		siteName: 'Example',
		byline: 'Ada',
		publishedAt: Date.parse('2026-08-30'),
		wordCount: 50
	})
	const [request, init] = fetcher.mock.calls[0]!
	expect(String(request)).toBe('https://readable.page/md?url=https%3A%2F%2Fexample.com%2Farticle')
	expect(init).toEqual({ headers: { accept: 'text/markdown' } })
})

test('derives a title from Markdown when no metadata is returned', async () => {
	const host = readerHost({
		fetch: vi.fn(async () => new Response(`# Heading from page\n\n${long}`))
	})

	await expect(call(host)).resolves.toMatchObject({
		title: 'Heading from page',
		wordCount: 53
	})
})

test('reports readable.page failures', async () => {
	const host = readerHost({ fetch: vi.fn(async () => new Response('failed', { status: 502 })) })

	await expect(call(host)).rejects.toThrow('readable.page returned 502')
})

test('rejects oversized responses before reading them', async () => {
	const host = readerHost({
		fetch: vi.fn(
			async () => new Response('small', { headers: { 'content-length': String(21 * 1024 * 1024) } })
		)
	})

	await expect(call(host)).rejects.toThrow('larger than 20 MB')
})

test('rejects non-web URLs before calling readable.page', async () => {
	const fetcher = vi.fn()
	const host = readerHost({ fetch: fetcher })

	await expect(call(host, 'file:///etc/passwd')).rejects.toThrow('HTTP or HTTPS')
	expect(fetcher).not.toHaveBeenCalled()
})

test('leaves opening URLs to the browser host', async () => {
	const host = readerHost()

	await expect(
		host.invoke({
			appId: 'test.reader',
			capability: 'reader',
			method: 'open',
			scopes: [],
			args: [{ url: 'https://example.com' }]
		})
	).rejects.toMatchObject({
		code: 'CAPABILITY_UNAVAILABLE',
		capability: 'reader',
		method: 'open'
	})
})

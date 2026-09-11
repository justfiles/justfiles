import { expect, test, vi } from 'vitest'
import { createFetchTool } from './fetch.ts'

test('direct pages stop downloading at one MiB, regardless of Content-Length', async () => {
	let chunks = 0
	const cancel = vi.fn()
	const response = new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (chunks++ < 40) controller.enqueue(new Uint8Array(64 * 1024).fill(65))
				else controller.close()
			},
			cancel
		}),
		{ headers: { 'content-type': 'text/plain', 'content-length': '8' } }
	)
	const tool = createFetchTool({ direct: true, fetch: async () => response })
	const result = await tool.execute('read', { url: 'https://example.com' })
	expect(result).toMatchObject({
		details: { sourceTruncated: true, truncated: true, bytes: 1024 * 1024 }
	})
	expect(result.content).toEqual([
		{ type: 'text', text: expect.stringContaining('Response truncated at 1048576 bytes') }
	])
	expect(chunks).toBeLessThanOrEqual(17)
	expect(cancel).toHaveBeenCalledTimes(1)
	expect(response.body?.locked).toBe(false)
})

test('a chunk larger than the download limit is sliced before decoding', async () => {
	const response = new Response(new Uint8Array(2 * 1024 * 1024).fill(65))
	const result = await createFetchTool({ direct: true, fetch: async () => response }).execute(
		'read',
		{ url: 'https://example.com' }
	)
	expect(result).toMatchObject({ details: { bytes: 1024 * 1024, sourceTruncated: true } })
})

test('bounded reads preserve UTF-8 across chunks and still convert HTML', async () => {
	const bytes = new TextEncoder().encode('<p>hello 🦊</p>')
	let offset = 0
	const response = new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset < bytes.length) controller.enqueue(bytes.subarray(offset, ++offset))
				else controller.close()
			}
		}),
		{ headers: { 'content-type': 'text/html' } }
	)
	const result = await createFetchTool({ direct: true, fetch: async () => response }).execute(
		'read',
		{ url: 'https://example.com' }
	)
	expect(result).toMatchObject({
		details: { truncated: false, sourceTruncated: false, converted: true }
	})
	expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('hello 🦊') }])
	expect(response.body?.locked).toBe(false)
})

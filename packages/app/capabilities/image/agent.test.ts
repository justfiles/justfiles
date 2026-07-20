import { memStorage, volume } from '@justfiles/fs'
import { expect, test } from 'vitest'
import type { ScopedInvoke } from '../core.ts'
import { imageAgentTools } from './agent.ts'

// 'AQID' = base64 of bytes [1, 2, 3]
const invoke: ScopedInvoke = async (method, input) => {
	expect(method).toBe('generateImage')
	expect(input).toEqual({ prompt: 'a red panda' })
	return { images: [{ data: 'AQID', mimeType: 'image/png' }] }
}

test('generate_image offloads bytes to the volume and returns refs in details', async () => {
	const vol = volume(memStorage())
	const [tool] = imageAgentTools
	const result = (await tool.execute(invoke, { prompt: 'a red panda' }, { volume: vol })) as {
		content: string
		details: { images: { src: string; mimeType: string; alt?: string }[] }
	}
	const [ref] = result.details.images
	expect(ref).toMatchObject({ mimeType: 'image/png', alt: 'a red panda' })
	expect(ref.src).toMatch(/^\/Pictures\/[0-9a-f]{8}\.png$/)
	// The model-facing text names the path but never carries the base64.
	expect(result.content).toContain(ref.src)
	expect(result.content).not.toContain('AQID')
	expect(await vol.readFile(ref.src)).toEqual(new Uint8Array([1, 2, 3]))
})

test('generate_image errors when the engine returns no image', async () => {
	const empty: ScopedInvoke = async () => ({ images: [] })
	const [tool] = imageAgentTools
	await expect(
		tool.execute(empty, { prompt: 'x' }, { volume: volume(memStorage()) })
	).rejects.toThrow(/no image/)
})

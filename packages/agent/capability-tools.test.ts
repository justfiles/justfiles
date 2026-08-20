import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { expect, test, vi } from 'vitest'
import { capabilityTools } from './capability-tools.ts'

function build(execute: Parameters<typeof capabilityTools>[1][number]['tools'][number]['execute']) {
	const invoke = vi.fn(async () => ({ ok: true }))
	const vol = volume(memStore())
	const [tool] = capabilityTools(
		invoke,
		[
			{
				capability: 'image',
				tools: [{ name: 't', description: 'd', parameters: { type: 'object' }, execute }]
			}
		],
		vol
	)
	if (!tool) throw new Error('no tool built')
	return { invoke, vol, tool }
}

test('binds execute to the agent actor and the owning capability', async () => {
	const { invoke, tool } = build((inv, params) => inv('method', params))
	const result = await tool.execute('call-1', { a: 1 })
	expect(invoke).toHaveBeenCalledWith({
		appId: 'agent',
		capability: 'image',
		method: 'method',
		args: [{ a: 1 }],
		scopes: []
	})
	// A plain return is JSON for the model.
	expect(result).toEqual({
		content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
		details: {}
	})
})

test('a structured return splits model-facing content from out-of-band details', async () => {
	const { tool } = build(async () => ({ content: 'saved', details: { images: [{ src: '/x' }] } }))
	expect(await tool.execute('call-1', {})).toEqual({
		content: [{ type: 'text', text: 'saved' }],
		details: { images: [{ src: '/x' }] }
	})
})

test('hands the volume to execute', async () => {
	const { vol, tool } = build(async (_inv, _params, ctx) => {
		await ctx.volume.writeFile('/probe', new Uint8Array([7]))
		return { content: 'ok' }
	})
	await tool.execute('call-1', {})
	expect(await vol.readFile('/probe')).toEqual(new Uint8Array([7]))
})

import { expect, test, vi } from 'vitest'
import { appTool } from './app-tool.ts'

test('discovers the SDK API for each declared binding without invoking it', async () => {
	const invoke = vi.fn()
	const tool = appTool({
		bindings: {
			files: { id: 'volume', scopes: ['app'] },
			mail: { id: 'email', scopes: ['read'] }
		},
		invoke
	})
	expect(await tool.execute('files', { capability: 'files' })).toMatchObject({
		content: [{ text: expect.stringContaining('writeFile(') }]
	})
	expect(await tool.execute('mail', { capability: 'mail' })).toMatchObject({
		content: [{ text: expect.stringContaining('listUnread(') }]
	})
	expect(invoke).not.toHaveBeenCalled()
})

test('capability arguments and results preserve text, binary bytes and bigint', async () => {
	const invoke = vi.fn(async (_name, _method, args) => args)
	const tool = appTool({ bindings: { files: { id: 'volume', scopes: [] } }, invoke })
	const args = [{ $bytes: 'hello 🦊' }, { $bytes: [0, 255, 254] }, { $bigint: '9007199254740993' }]
	const result = await tool.execute('call', { capability: 'files', method: 'echo', args })
	expect(invoke).toHaveBeenCalledWith('files', 'echo', [
		new TextEncoder().encode('hello 🦊'),
		new Uint8Array([0, 255, 254]),
		9007199254740993n
	])
	expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(args) }])
})

test('an aborted tool call cannot start a capability operation', async () => {
	const invoke = vi.fn()
	const tool = appTool({ bindings: { files: { id: 'volume', scopes: [] } }, invoke })
	await expect(
		tool.execute('call', { capability: 'files', method: 'rm', args: ['/'] }, AbortSignal.abort())
	).rejects.toThrow()
	expect(invoke).not.toHaveBeenCalled()
})

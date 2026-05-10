// Behaviour tests for the client-only volume RPC dispatcher. Exercises the
// public boundary — frame in, frame out — the way the WS loop calls it.

import { describe, expect, test } from 'bun:test'
import type { CapabilityBridge } from '@justfiles/app/capabilities-bridge.js'
import { type Volume, volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { type ClientToolDescriptor, dispatchAppRpc } from './app-rpc'

const APP_ID = 'demo'

function makeVol(): Volume {
	return volume(memStorage())
}

const denyAllBridge: CapabilityBridge = {
	async invoke() {
		throw new Error('bridge not stubbed')
	}
}

const noopSend = async () => ''
const noopRegisterTool = (_descriptor: ClientToolDescriptor) => {}

const writeText = (id: string, path: string, text: string) => ({
	id,
	method: 'app.volume.writeText' as const,
	params: { path, text }
})
const readText = (id: string, path: string) => ({
	id,
	method: 'app.volume.readText' as const,
	params: { path }
})
const writeFile = (id: string, path: string, bytes: string) => ({
	id,
	method: 'app.volume.writeFile' as const,
	params: { path, bytes }
})
const readFile = (id: string, path: string) => ({
	id,
	method: 'app.volume.readFile' as const,
	params: { path }
})

describe('dispatchAppRpc', () => {
	test('text round-trip persists under app-private storage', async () => {
		const vol = makeVol()
		const ctx = {
			vol,
			appId: APP_ID,
			permissions: ['volume'] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		const writeReply = await dispatchAppRpc(ctx, writeText('1', 'last.txt', 'hello'))
		expect(writeReply).toEqual({ jsonrpc: '2.0', id: '1', result: null })

		const readReply = await dispatchAppRpc(ctx, readText('2', 'last.txt'))
		expect(readReply).toEqual({ jsonrpc: '2.0', id: '2', result: { text: 'hello' } })

		const stored = new TextDecoder().decode(await vol.readFile(`/apps/${APP_ID}/private/last.txt`))
		expect(stored).toBe('hello')
	})

	test('binary round-trip preserves bytes including high values', async () => {
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: ['volume'] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		const bytes = btoa('\x00\x01\x02\xfa\xff')
		await dispatchAppRpc(ctx, writeFile('1', 'blob.bin', bytes))
		const reply = await dispatchAppRpc(ctx, readFile('2', 'blob.bin'))
		expect(reply.result).toEqual({ bytes })
	})

	test('readText on missing file returns the not_found error code', async () => {
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: ['volume'] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		const reply = await dispatchAppRpc(ctx, readText('1', 'missing.txt'))
		expect(reply.error?.code).toBe(-32001)
		expect(reply.error?.message).toBe('not_found')
		expect(reply.result).toBeUndefined()
	})

	test('paths escaping the app-private root are rejected', async () => {
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: ['volume'] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		const cases = ['../escape', 'a/../b', '..', '']
		for (const path of cases) {
			const reply = await dispatchAppRpc(ctx, writeText('x', path, 'nope'))
			expect(reply.error?.code).toBe(-32002)
			expect(reply.error?.message).toBe('invalid_path')
		}
	})

	test('app private storage is scoped per appId', async () => {
		const vol = makeVol()
		const perms = ['volume'] as const
		await dispatchAppRpc(
			{
				vol,
				appId: 'one',
				permissions: perms,
				bridge: denyAllBridge,
				sendAgentPrompt: noopSend,
				registerClientTool: noopRegisterTool
			},
			writeText('1', 'shared.txt', 'one-secret')
		)
		await dispatchAppRpc(
			{
				vol,
				appId: 'two',
				permissions: perms,
				bridge: denyAllBridge,
				sendAgentPrompt: noopSend,
				registerClientTool: noopRegisterTool
			},
			writeText('2', 'shared.txt', 'two-secret')
		)
		const oneReply = await dispatchAppRpc(
			{
				vol,
				appId: 'one',
				permissions: perms,
				bridge: denyAllBridge,
				sendAgentPrompt: noopSend,
				registerClientTool: noopRegisterTool
			},
			readText('3', 'shared.txt')
		)
		const twoReply = await dispatchAppRpc(
			{
				vol,
				appId: 'two',
				permissions: perms,
				bridge: denyAllBridge,
				sendAgentPrompt: noopSend,
				registerClientTool: noopRegisterTool
			},
			readText('4', 'shared.txt')
		)
		expect(oneReply.result).toEqual({ text: 'one-secret' })
		expect(twoReply.result).toEqual({ text: 'two-secret' })
	})

	test('volume calls without the volume permission return permission_denied', async () => {
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: [] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		const cases = [
			writeText('1', 'last.txt', 'hi'),
			readText('2', 'last.txt'),
			writeFile('3', 'blob.bin', btoa('x')),
			readFile('4', 'blob.bin')
		]
		for (const frame of cases) {
			const reply = await dispatchAppRpc(ctx, frame)
			expect(reply.error?.code).toBe(-32005)
			expect(reply.error?.message).toBe('permission_denied')
			expect(reply.error?.data).toEqual({ permission: 'volume' })
			expect(reply.result).toBeUndefined()
		}
	})

	test('denied volume writes do not touch the underlying volume', async () => {
		const vol = makeVol()
		const reply = await dispatchAppRpc(
			{
				vol,
				appId: APP_ID,
				permissions: [] as const,
				bridge: denyAllBridge,
				sendAgentPrompt: noopSend,
				registerClientTool: noopRegisterTool
			},
			writeText('1', 'leaked.txt', 'should not persist')
		)
		expect(reply.error?.code).toBe(-32005)
		await expect(vol.readFile(`/apps/${APP_ID}/private/leaked.txt`)).rejects.toThrow(/ENOENT/)
	})

	test('unknown methods report method_not_found before permission gate', async () => {
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: [] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		const reply = await dispatchAppRpc(ctx, {
			id: '1',
			method: 'app.volume.unlink',
			params: { path: 'last.txt' }
		})
		expect(reply.error?.code).toBe(-32601)
	})

	test('invalid base64 bytes return invalid_payload', async () => {
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: ['volume'] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		const reply = await dispatchAppRpc(ctx, writeFile('1', 'blob.bin', 'not!base64!!'))
		expect(reply.error?.code).toBe(-32003)
		expect(reply.error?.message).toBe('invalid_payload')
	})

	test('unknown method returns method_not_found', async () => {
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: ['volume'] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		const reply = await dispatchAppRpc(ctx, {
			id: '1',
			method: 'app.volume.unlink',
			params: { path: 'last.txt' }
		})
		expect(reply.error?.code).toBe(-32601)
	})

	test('writeText creates parent directories implicitly', async () => {
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: ['volume'] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		const reply = await dispatchAppRpc(ctx, writeText('1', 'nested/dir/file.txt', 'x'))
		expect(reply).toEqual({ jsonrpc: '2.0', id: '1', result: null })
		const readReply = await dispatchAppRpc(ctx, readText('2', 'nested/dir/file.txt'))
		expect(readReply.result).toEqual({ text: 'x' })
	})

	// ── capability invocation ────────────────────────────────────────────

	const invoke = (id: string, capability: string, method: string, input: unknown) => ({
		id,
		method: 'app.capability.invoke' as const,
		params: { capability, method, input }
	})

	test('capability.invoke routes generically through the host bridge', async () => {
		const calls: { capability: string; method: string; input: unknown }[] = []
		const bridge: CapabilityBridge = {
			async invoke(req) {
				calls.push(req)
				return [{ id: 'e1', subject: 'hello' }]
			}
		}
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: [] as const,
			bridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		const reply = await dispatchAppRpc(
			ctx,
			invoke('1', 'email', 'listUnread', { limit: 5, accountId: 'primary' })
		)
		expect(reply).toEqual({
			jsonrpc: '2.0',
			id: '1',
			result: { value: [{ id: 'e1', subject: 'hello' }] }
		})
		expect(calls).toEqual([
			{ capability: 'email', method: 'listUnread', input: { limit: 5, accountId: 'primary' } }
		])
	})

	test('capability denial maps to capability_denied with capability/method data', async () => {
		const bridge: CapabilityBridge = {
			async invoke() {
				throw Object.assign(new Error('missing scope: read.unread'), {
					code: 'CAPABILITY_DENIED'
				})
			}
		}
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: [] as const,
			bridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		const reply = await dispatchAppRpc(ctx, invoke('1', 'email', 'listUnread', {}))
		expect(reply.error?.code).toBe(-32010)
		expect(reply.error?.message).toBe('missing scope: read.unread')
		expect(reply.error?.data).toEqual({ capability: 'email', method: 'listUnread' })
		expect(reply.result).toBeUndefined()
	})

	test('capability failure maps to capability_failed with capability/method data', async () => {
		const bridge: CapabilityBridge = {
			async invoke() {
				throw Object.assign(new Error('upstream down'), { code: 'CAPABILITY_FAILED' })
			}
		}
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: [] as const,
			bridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		const reply = await dispatchAppRpc(
			ctx,
			invoke('1', 'calendar', 'listToday', { timezone: 'UTC' })
		)
		expect(reply.error?.code).toBe(-32011)
		expect(reply.error?.message).toBe('upstream down')
		expect(reply.error?.data).toEqual({ capability: 'calendar', method: 'listToday' })
	})

	test('capability invocation does not require any manifest permission', async () => {
		const bridge: CapabilityBridge = {
			async invoke() {
				return { ok: true }
			}
		}
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: [] as const,
			bridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		const reply = await dispatchAppRpc(ctx, invoke('1', 'email', 'listUnread', {}))
		expect(reply.error).toBeUndefined()
		expect(reply.result).toEqual({ value: { ok: true } })
	})

	test('capability.invoke with empty capability id returns invalid_payload', async () => {
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: [] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		const reply = await dispatchAppRpc(ctx, invoke('1', '', 'listUnread', {}))
		expect(reply.error?.code).toBe(-32003)
	})

	// ── agent send ──────────────────────────────────────────────────────

	const agentSend = (id: string, text: unknown) => ({
		id,
		method: 'app.agent.send' as const,
		params: { text } as { text: string }
	})

	test('agent.send forwards text to the host and returns the assistant text', async () => {
		const sent: string[] = []
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: ['agent'] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: async (text: string) => {
				sent.push(text)
				return 'done'
			},
			registerClientTool: noopRegisterTool
		}
		const reply = await dispatchAppRpc(ctx, agentSend('1', 'hello agent'))
		expect(reply).toEqual({ jsonrpc: '2.0', id: '1', result: { text: 'done' } })
		expect(sent).toEqual(['hello agent'])
	})

	test('agent.send without the agent permission returns permission_denied', async () => {
		const sent: string[] = []
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: [] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: async (text: string) => {
				sent.push(text)
				return ''
			},
			registerClientTool: noopRegisterTool
		}
		const reply = await dispatchAppRpc(ctx, agentSend('1', 'hello agent'))
		expect(reply.error?.code).toBe(-32005)
		expect(reply.error?.message).toBe('permission_denied')
		expect(reply.error?.data).toEqual({ permission: 'agent' })
		expect(sent).toEqual([])
	})

	test('agent.send with non-string or empty text returns invalid_payload', async () => {
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: ['agent'] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		for (const text of ['', 42, null, undefined, {}]) {
			const reply = await dispatchAppRpc(ctx, agentSend('x', text))
			expect(reply.error?.code).toBe(-32003)
			expect(reply.error?.message).toBe('invalid_payload')
		}
	})

	test('agent.send surfaces host failure as internal_error', async () => {
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: ['agent'] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: async () => {
				throw new Error('runtime missing')
			},
			registerClientTool: noopRegisterTool
		}
		const reply = await dispatchAppRpc(ctx, agentSend('1', 'hi'))
		expect(reply.error?.code).toBe(-32000)
		expect(reply.error?.message).toBe('runtime missing')
	})

	// ── client tool registration ────────────────────────────────────────

	const toolRegister = (id: string, params: ClientToolDescriptor) => ({
		id,
		method: 'app.tool.register' as const,
		params
	})

	test('app.tool.register forwards descriptor to ctx.registerClientTool', async () => {
		const registered: ClientToolDescriptor[] = []
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: [] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: noopSend,
			registerClientTool: (d: ClientToolDescriptor) => {
				registered.push(d)
			}
		}
		const reply = await dispatchAppRpc(
			ctx,
			toolRegister('1', { name: 'highlight', description: 'Highlights text', schema: {} })
		)
		expect(reply).toEqual({ jsonrpc: '2.0', id: '1', result: null })
		expect(registered).toEqual([{ name: 'highlight', description: 'Highlights text', schema: {} }])
	})

	test('app.tool.register with empty name returns invalid_payload', async () => {
		const ctx = {
			vol: makeVol(),
			appId: APP_ID,
			permissions: [] as const,
			bridge: denyAllBridge,
			sendAgentPrompt: noopSend,
			registerClientTool: noopRegisterTool
		}
		const reply = await dispatchAppRpc(
			ctx,
			toolRegister('1', { name: '', description: 'x', schema: {} })
		)
		expect(reply.error?.code).toBe(-32003)
	})
})

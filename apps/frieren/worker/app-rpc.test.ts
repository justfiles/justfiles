// Behaviour tests for the client-only volume RPC dispatcher. Exercises the
// public boundary — frame in, frame out — the way the WS loop calls it.

import { describe, expect, test } from 'bun:test'
import { type Volume, volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { dispatchAppRpc } from './app-rpc'

const APP_ID = 'demo'

function makeVol(): Volume {
	return volume(memStorage())
}

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
		const ctx = { vol, appId: APP_ID, permissions: ['volume'] as const }
		const writeReply = await dispatchAppRpc(ctx, writeText('1', 'last.txt', 'hello'))
		expect(writeReply).toEqual({ jsonrpc: '2.0', id: '1', result: null })

		const readReply = await dispatchAppRpc(ctx, readText('2', 'last.txt'))
		expect(readReply).toEqual({ jsonrpc: '2.0', id: '2', result: { text: 'hello' } })

		const stored = new TextDecoder().decode(await vol.readFile(`/apps/${APP_ID}/private/last.txt`))
		expect(stored).toBe('hello')
	})

	test('binary round-trip preserves bytes including high values', async () => {
		const ctx = { vol: makeVol(), appId: APP_ID, permissions: ['volume'] as const }
		const bytes = btoa('\x00\x01\x02\xfa\xff')
		await dispatchAppRpc(ctx, writeFile('1', 'blob.bin', bytes))
		const reply = await dispatchAppRpc(ctx, readFile('2', 'blob.bin'))
		expect(reply.result).toEqual({ bytes })
	})

	test('readText on missing file returns the not_found error code', async () => {
		const ctx = { vol: makeVol(), appId: APP_ID, permissions: ['volume'] as const }
		const reply = await dispatchAppRpc(ctx, readText('1', 'missing.txt'))
		expect(reply.error?.code).toBe(-32001)
		expect(reply.error?.message).toBe('not_found')
		expect(reply.result).toBeUndefined()
	})

	test('paths escaping the app-private root are rejected', async () => {
		const ctx = { vol: makeVol(), appId: APP_ID, permissions: ['volume'] as const }
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
			{ vol, appId: 'one', permissions: perms },
			writeText('1', 'shared.txt', 'one-secret')
		)
		await dispatchAppRpc(
			{ vol, appId: 'two', permissions: perms },
			writeText('2', 'shared.txt', 'two-secret')
		)
		const oneReply = await dispatchAppRpc(
			{ vol, appId: 'one', permissions: perms },
			readText('3', 'shared.txt')
		)
		const twoReply = await dispatchAppRpc(
			{ vol, appId: 'two', permissions: perms },
			readText('4', 'shared.txt')
		)
		expect(oneReply.result).toEqual({ text: 'one-secret' })
		expect(twoReply.result).toEqual({ text: 'two-secret' })
	})

	test('volume calls without the volume permission return permission_denied', async () => {
		const ctx = { vol: makeVol(), appId: APP_ID, permissions: [] as const }
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
			{ vol, appId: APP_ID, permissions: [] as const },
			writeText('1', 'leaked.txt', 'should not persist')
		)
		expect(reply.error?.code).toBe(-32005)
		await expect(vol.readFile(`/apps/${APP_ID}/private/leaked.txt`)).rejects.toThrow(/ENOENT/)
	})

	test('unknown methods report method_not_found before permission gate', async () => {
		const ctx = { vol: makeVol(), appId: APP_ID, permissions: [] as const }
		const reply = await dispatchAppRpc(ctx, {
			id: '1',
			method: 'app.volume.unlink',
			params: { path: 'last.txt' }
		})
		expect(reply.error?.code).toBe(-32601)
	})

	test('invalid base64 bytes return invalid_payload', async () => {
		const ctx = { vol: makeVol(), appId: APP_ID, permissions: ['volume'] as const }
		const reply = await dispatchAppRpc(ctx, writeFile('1', 'blob.bin', 'not!base64!!'))
		expect(reply.error?.code).toBe(-32003)
		expect(reply.error?.message).toBe('invalid_payload')
	})

	test('unknown method returns method_not_found', async () => {
		const ctx = { vol: makeVol(), appId: APP_ID, permissions: ['volume'] as const }
		const reply = await dispatchAppRpc(ctx, {
			id: '1',
			method: 'app.volume.unlink',
			params: { path: 'last.txt' }
		})
		expect(reply.error?.code).toBe(-32601)
	})

	test('writeText creates parent directories implicitly', async () => {
		const ctx = { vol: makeVol(), appId: APP_ID, permissions: ['volume'] as const }
		const reply = await dispatchAppRpc(ctx, writeText('1', 'nested/dir/file.txt', 'x'))
		expect(reply).toEqual({ jsonrpc: '2.0', id: '1', result: null })
		const readReply = await dispatchAppRpc(ctx, readText('2', 'nested/dir/file.txt'))
		expect(readReply.result).toEqual({ text: 'x' })
	})
})

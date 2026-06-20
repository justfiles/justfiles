import { type Capability, type CapabilityCall, CapabilityError } from '@justfiles/app/capabilities'
import { describe, expect, test } from 'vitest'
import { AuditLog } from '../integrations/audit.ts'
import { TokenBucket } from '../integrations/rate-limit.ts'
import type { KvStorage } from '../integrations/storage.ts'
import { guardCapability } from './guard.ts'

function memKv(): KvStorage {
	const map = new Map<string, unknown>()
	return {
		get: async <T>(k: string) => map.get(k) as T | undefined,
		put: async <T>(k: string, v: T) => void map.set(k, v),
		delete: async (k: string) => map.delete(k),
		list: async <T>(opts?: { prefix?: string }) => {
			const out = new Map<string, T>()
			for (const [k, v] of map) if (!opts?.prefix || k.startsWith(opts.prefix)) out.set(k, v as T)
			return out
		}
	}
}

const call = (over: Partial<CapabilityCall> = {}): CapabilityCall => ({
	appId: 'agent',
	capability: 'email',
	method: 'listUnread',
	args: [{}],
	scopes: [],
	...over
})

function setup(over: { inner?: Capability; capacity?: number } = {}) {
	const audit = new AuditLog(memKv())
	const rateLimit = new TokenBucket({ capacity: over.capacity ?? 5, windowMs: 60_000 })
	const inner: Capability = over.inner ?? {
		invoke: async () => 'ok',
		subscribe: async () => () => {}
	}
	return { cap: guardCapability(inner, { capability: 'email', audit, rateLimit }), audit }
}

describe('guardCapability', () => {
	test('passes the call through and audits a success', async () => {
		const { cap, audit } = setup()
		expect(await cap.invoke(call())).toBe('ok')
		const [entry] = await audit.list()
		expect(entry).toMatchObject({ integrationId: 'email', command: 'listUnread', exitCode: 0 })
	})

	test('audits a failure and rethrows', async () => {
		const { cap, audit } = setup({
			inner: {
				invoke: async () => {
					throw new Error('boom')
				},
				subscribe: async () => () => {}
			}
		})
		await expect(cap.invoke(call())).rejects.toThrow('boom')
		expect((await audit.list())[0]).toMatchObject({ exitCode: 1 })
	})

	test('rate-limits per capability+account, audits the rejection', async () => {
		const { cap, audit } = setup({ capacity: 1 })
		await cap.invoke(call({ args: [{ accountId: 'a' }] }))
		// second call for the same account is over budget
		await expect(cap.invoke(call({ args: [{ accountId: 'a' }] }))).rejects.toBeInstanceOf(
			CapabilityError
		)
		// a different account has its own bucket
		expect(await cap.invoke(call({ args: [{ accountId: 'b' }] }))).toBe('ok')
		expect((await audit.list()).map((e) => e.exitCode)).toEqual([0, 429, 0])
	})
})

import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { afterEach, expect, test, vi } from 'vitest'
import { type AccountsOptions, aesGcmSecretCodec, hostAccounts } from './host.ts'
import type { AcquiredAccount, Auth, Provider } from './provider.ts'

const ref = { providerId: 'test', operationId: 'attempt-1' }
const account = { accountId: 'person', creds: { access: 'private-token' } }

function setup(acquire: Auth['acquire'], opts: AccountsOptions = {}, fs = volume(memStore())) {
	const provider: Provider = {
		id: 'test',
		name: 'Test',
		auth: { ui: { kind: 'interactive' }, acquire },
		capabilities: { ai: { bind: () => ({ generateText: async () => ({ text: '' }) }) } }
	}
	return { fs, providers: [provider], host: hostAccounts([provider], fs, opts) }
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

afterEach(() => vi.useRealTimers())

test('sign-in can be polled and retried without starting another grant', async () => {
	const grant = deferred<AcquiredAccount>()
	const acquire = vi.fn<Auth['acquire']>(async ({ notify }) => {
		notify?.({ verificationUrl: 'https://example.com/login', userCode: 'ABCD', intervalMs: 1000 })
		return grant.promise
	})
	const { host } = setup(acquire)
	await host.admin.beginConnect(ref)
	await host.admin.beginConnect(ref)
	expect(acquire).toHaveBeenCalledTimes(1)
	expect(await host.admin.readConnect(ref)).toMatchObject({
		status: 'pending',
		prompt: { userCode: 'ABCD' }
	})
	grant.resolve(account)
	await vi.waitFor(async () =>
		expect(await host.admin.readConnect(ref)).toMatchObject({
			status: 'connected',
			accountId: 'person'
		})
	)
	expect(JSON.stringify(await host.admin.readConnect(ref))).not.toContain('private-token')
	expect(await host.admin.listAccounts({})).toMatchObject([{ accountId: 'person', enabled: [] }])
})

test('cancelling before a late grant preserves the existing credential', async () => {
	const grant = deferred<AcquiredAccount>()
	let signingIn = false
	const { host } = setup(async () => (signingIn ? grant.promise : account))
	await host.admin.connect({ providerId: 'test' })
	await host.admin.setEnabled({ accountId: 'person', capability: 'ai', enabled: true })
	signingIn = true
	await host.admin.beginConnect(ref)
	await host.admin.cancelConnect(ref)
	grant.resolve({ ...account, creds: { access: 'late-token' } })
	await new Promise((resolve) => setTimeout(resolve, 0))
	expect(await host.admin.readConnect(ref)).toMatchObject({ status: 'cancelled' })
	expect(await host.resolveAi((lease) => lease.creds)).toEqual(account.creds)
})

test('a lost running host reports an expired operation', async () => {
	const { fs, providers, host } = setup(async () => account)
	await host.admin.beginConnect(ref)
	expect(await hostAccounts(providers, fs).admin.readConnect(ref)).toMatchObject({
		status: 'expired'
	})
})

test('expiry aborts the provider and cannot save a late grant', async () => {
	vi.useFakeTimers()
	let signal: AbortSignal | undefined
	const grant = deferred<AcquiredAccount>()
	const { host } = setup(async (input) => {
		signal = input.signal
		return grant.promise
	})
	await host.admin.beginConnect(ref)
	await vi.advanceTimersByTimeAsync(15 * 60_000)
	expect(signal?.aborted).toBe(true)
	expect(await host.admin.readConnect(ref)).toMatchObject({ status: 'expired' })
	grant.resolve(account)
	await vi.runAllTimersAsync()
	expect(await host.admin.listAccounts({})).toEqual([])
})

test.each([
	{ phase: 'encode', existing: false, action: 'cancel' },
	{ phase: 'encode', existing: true, action: 'cancel' },
	{ phase: 'write', existing: false, action: 'cancel' },
	{ phase: 'write', existing: true, action: 'cancel' },
	{ phase: 'encode', existing: false, action: 'expire' },
	{ phase: 'encode', existing: true, action: 'expire' },
	{ phase: 'write', existing: false, action: 'expire' },
	{ phase: 'write', existing: true, action: 'expire' }
])('$action during $phase restores the account (existing=$existing)', async ({
	phase,
	existing,
	action
}) => {
	vi.useFakeTimers()
	const fs = volume(memStore())
	const codec = aesGcmSecretCodec('test-key')
	const entered = deferred<void>()
	const resume = deferred<void>()
	const work: Promise<unknown>[] = []
	let acquired = account
	let pause = false
	const block = async () => {
		if (!pause) return
		pause = false
		entered.resolve()
		await resume.promise
	}
	const wrapped = {
		...fs,
		writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
			await fs.writeFile(...args)
			if (phase === 'write') await block()
		}
	}
	const { host } = setup(
		async () => acquired,
		{
			secretCodec: {
				...codec,
				encode: async (...args) => {
					if (phase === 'encode') await block()
					return codec.encode(...args)
				}
			},
			waitUntil: (task) => work.push(task)
		},
		wrapped
	)
	if (existing) {
		await host.admin.connect({ providerId: 'test' })
		await host.admin.setEnabled({ accountId: 'person', capability: 'ai', enabled: true })
	}
	const path = '/private/accounts/person.json'
	const before = existing ? await fs.readFile(path) : undefined
	acquired = { ...account, creds: { access: 'replacement-token' } }
	pause = true
	await host.admin.beginConnect(ref)
	await entered.promise
	if (action === 'cancel') await host.admin.cancelConnect(ref)
	else await vi.advanceTimersByTimeAsync(15 * 60_000)
	const reading = existing ? host.resolveAi((lease) => lease.creds) : undefined
	resume.resolve()
	await Promise.all(work)
	expect.soft(await host.admin.readConnect(ref)).toMatchObject({
		status: action === 'cancel' ? 'cancelled' : 'expired'
	})
	if (existing) {
		expect(await fs.readFile(path)).toEqual(before)
		expect(await reading).toEqual(account.creds)
	} else {
		expect(await fs.exists(path)).toBe(false)
		expect(await host.admin.listAccounts({})).toEqual([])
	}
})

test('separate backend leases refresh through the same account lock', async () => {
	const { host } = setup(async () => ({ ...account, creds: { expired: true } }))
	await host.admin.connect({ providerId: 'test' })
	await host.admin.setEnabled({ accountId: 'person', capability: 'ai', enabled: true })
	const first = (await host.resolveAi((lease) => lease))!
	const second = (await host.resolveAi((lease) => lease))!
	let exchanges = 0
	const refresh = async (creds: unknown) => {
		if (!(creds as { expired: boolean }).expired) return undefined
		exchanges++
		await new Promise((resolve) => setTimeout(resolve, 5))
		return { expired: false }
	}
	expect(
		await Promise.all([first.credentials.modify(refresh), second.credentials.modify(refresh)])
	).toEqual([{ expired: false }, { expired: false }])
	expect(exchanges).toBe(1)
	expect(await host.resolveAi((lease) => lease.revision)).toBe(first.revision)
	await host.admin.connect({ providerId: 'test' })
	await expect(first.credentials.read()).rejects.toThrow('Account changed')
	await expect(
		host.resolveAi((lease) => lease, {
			accountId: 'person',
			revision: first.revision
		})
	).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
})

test('disconnect waits for an admitted refresh, then invalidates every old lease', async () => {
	const { host } = setup(async () => account)
	await host.admin.connect({ providerId: 'test' })
	await host.admin.setEnabled({ accountId: 'person', capability: 'ai', enabled: true })
	const lease = (await host.resolveAi((value) => value))!
	const started = deferred<void>()
	const finish = deferred<unknown>()
	const refresh = lease.credentials.modify(async () => {
		started.resolve()
		return finish.promise
	})
	await started.promise
	const disconnect = host.admin.disconnect({ accountId: 'person' })
	finish.resolve({ access: 'rotated' })
	await Promise.all([refresh, disconnect])
	expect(await host.admin.listAccounts({})).toEqual([])
	await expect(lease.credentials.read()).rejects.toThrow('disconnected')
})

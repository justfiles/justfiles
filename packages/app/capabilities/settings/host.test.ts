import { memStorage, volume } from '@justfiles/fs'
import { expect, test } from 'vitest'
import { accountsCapabilities } from '../accounts/host.ts'
import { icloudProvider } from '../accounts/providers/icloud.ts'
import { platformProvider } from '../accounts/providers/platform.ts'
import type { Capabilities, CapabilityCall } from '../types.ts'
import { SETTINGS_ALLOWLIST, type SettingsHostDeps, settingsHost } from './host.ts'

// `settings` is the host admin surface as ONE gated bucket. What matters here is the
// composition — the identity gate, and which methods this host serves vs delegates —
// so the accounts methods run against a REAL admin impl over an in-memory Volume
// (their own behaviour is covered in accounts/host.test.ts).

const SETTINGS = [...SETTINGS_ALLOWLIST][0] as string

const METHODS = [
	'accounts.listProviders',
	'accounts.listAccounts',
	'accounts.connect',
	'accounts.setEnabled',
	'accounts.disconnect',
	'host.usage',
	'host.user'
]

// The app declares NO scopes (the gate is identity), so every frame carries `[]`.
function call(method: string, args: unknown = {}, appId = SETTINGS): CapabilityCall {
	return { appId, capability: 'settings', method, args: [args], scopes: [] }
}

const snapshot = {
	tier: 'free',
	aiBurst: { used: 1, limit: 2, remaining: 1, exceeded: false, fraction: 0.5, resetsAt: 9 },
	aiWeekly: { used: 1, limit: 2, remaining: 1, exceeded: false, fraction: 0.5, resetsAt: 9 },
	storage: { used: 1, limit: null, remaining: null, exceeded: false, fraction: 0 },
	aiTokens: 10,
	aiRequests: 2
}

// A host with the real accounts admin impl over a throwaway Volume, plus whatever
// else the case wires.
function host(over: Omit<SettingsHostDeps, 'accounts'> = {}) {
	const vol = volume(memStorage())
	const providers = [icloudProvider(), platformProvider({ generate: async () => 'x' })]
	const { accounts } = accountsCapabilities(providers, vol)
	return settingsHost({ accounts, ...over })
}

test('accounts.* administer the machine: connect, project, toggle ai, disconnect', async () => {
	const caps = host()
	const providers = (await caps.invoke(call('accounts.listProviders'))) as {
		id: string
		authKind: string
		builtin?: boolean
		credentialsSchema?: unknown
	}[]
	expect(providers.map((p) => [p.id, p.authKind])).toEqual([
		['icloud', 'form'],
		['frieren', 'none']
	])
	expect(providers[0]?.credentialsSchema).toBeTruthy()
	expect(providers[1]?.builtin).toBe(true)

	expect(
		await caps.invoke(
			call('accounts.connect', {
				providerId: 'icloud',
				credentials: { username: 'u@me.com', password: 'p' }
			})
		)
	).toEqual({ accountId: 'u@me.com' })
	await caps.invoke(call('accounts.connect', { providerId: 'frieren' }))
	await caps.invoke(
		call('accounts.setEnabled', { accountId: 'frieren', capability: 'ai', enabled: true })
	)

	const listed = () =>
		caps.invoke(call('accounts.listAccounts')) as Promise<
			{ accountId: string; enabled: string[] }[]
		>
	expect((await listed()).map((a) => [a.accountId, a.enabled.join('+')])).toEqual([
		['u@me.com', 'calendar'],
		['frieren', 'ai']
	])

	await caps.invoke(call('accounts.disconnect', { accountId: 'u@me.com' }))
	expect((await listed()).map((a) => a.accountId)).toEqual(['frieren'])
})

test('a non-allowlisted app cannot tell any of it exists', async () => {
	const caps = host({ usage: async () => snapshot, user: async () => ({ id: 'u' }) })
	for (const method of METHODS) {
		await expect(caps.invoke(call(method, {}, 'app.evil'))).rejects.toMatchObject({
			code: 'CAPABILITY_UNAVAILABLE',
			capability: 'settings'
		})
	}
})

test('the gate is identity, not scope: the allowlisted app declares none', async () => {
	const caps = host()
	expect(await caps.invoke({ ...call('accounts.listProviders'), scopes: [] })).toHaveLength(2)
})

test('host.usage is the snapshot with a meter, UNAVAILABLE without one', async () => {
	expect(await host({ usage: async () => snapshot }).invoke(call('host.usage'))).toEqual(snapshot)
	// The Mac app wires no meter — the app hides the Usage pane on exactly this.
	await expect(host().invoke(call('host.usage'))).rejects.toMatchObject({
		code: 'CAPABILITY_UNAVAILABLE'
	})
})

test('host.user is null with no session — an answer, not an error', async () => {
	expect(await host().invoke(call('host.user'))).toBeNull()
	expect(
		await host({ user: () => ({ id: 'u1', name: 'Fern' }) }).invoke(call('host.user'))
	).toEqual({ id: 'u1', name: 'Fern' })
})

test('a method with no dep here goes to the remote, frame intact; the rest stay local', async () => {
	const forwarded: CapabilityCall[] = []
	const remote: Capabilities = {
		invoke: async (c) => {
			forwarded.push(c)
			return []
		},
		subscribe: async () => () => {}
	}
	// The frieren browser half: identity is local, accounts + usage live on the DO.
	const caps = settingsHost({ user: () => ({ id: 'u1' }), remote })

	expect(await caps.invoke(call('accounts.listAccounts'))).toEqual([])
	expect(await caps.invoke(call('host.usage'))).toEqual([])
	expect(forwarded).toEqual([call('accounts.listAccounts'), call('host.usage')])

	expect(await caps.invoke(call('host.user'))).toEqual({ id: 'u1' })
	expect(forwarded).toHaveLength(2)
})

test('an unknown method (or a subscribe) is UNAVAILABLE, never a crash', async () => {
	const caps = host()
	await expect(caps.invoke(call('accounts.nope'))).rejects.toMatchObject({
		code: 'CAPABILITY_UNAVAILABLE'
	})
	await expect(caps.subscribe(call('host.usage'), () => {})).rejects.toMatchObject({
		code: 'CAPABILITY_UNAVAILABLE'
	})
})

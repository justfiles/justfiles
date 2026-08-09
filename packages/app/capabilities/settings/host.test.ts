import { memStorage, volume } from '@justfiles/fs'
import { expect, test, vi } from 'vitest'
import { accountsCapabilities } from '../accounts/host.ts'
import { icloudProvider } from '../accounts/providers/icloud.ts'
import { platformProvider } from '../accounts/providers/platform.ts'
import type { Capabilities, CapabilityCall } from '../types.ts'
import type { AvatarInfo } from './contract.ts'
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

// Every method that needs the Volume (or the generator): served only where its dep is.
const AGENT_METHODS = [
	'agent.readSoul',
	'agent.writeSoul',
	'agent.listAvatars',
	'agent.putAvatarFile',
	'agent.readProfile',
	'agent.writeProfile',
	'agent.generateSoul'
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

// D1's "two lanes" on one device (#290/#296): a signed-in Mac can hold accounts both
// connected directly on it AND owned by the cloud, reached through `remote` (#305).
// `accounts.listAccounts` is the one method that unions them; every other accounts.*
// method stays single-sided.
test('accounts.listAccounts unions the local list with the remote one when both are wired', async () => {
	const vol = volume(memStorage())
	const providers = [icloudProvider(), platformProvider({ generate: async () => 'x' })]
	const { accounts } = accountsCapabilities(providers, vol, {
		origin: { kind: 'device', label: 'This Mac' }
	})
	await accounts.connect({
		providerId: 'icloud',
		credentials: { username: 'u@me.com', password: 'p' }
	})
	const cloudAccount = {
		accountId: 'g@gmail.com',
		providerId: 'google',
		enabled: [],
		config: {},
		origin: { kind: 'cloud' }
	}
	const remote: Capabilities = {
		invoke: async () => [cloudAccount],
		subscribe: async () => () => {}
	}
	const caps = settingsHost({ accounts, remote })

	const list = (await caps.invoke(call('accounts.listAccounts'))) as { accountId: string }[]
	expect(list.map((a) => a.accountId).sort()).toEqual(['g@gmail.com', 'u@me.com'])
})

// The Mac's own catalog never carries the cloud's built-in AI provider (its
// `accountsProviders()` is google/icloud/chatgpt — see `apps/mac/daemon/kernel.ts`).
// Without this, a merged built-in account has no local `ProviderInfo`, so
// `provider?.builtin` reads as `undefined` in the GUI and it renders a Disconnect
// button for the platform's floor AI account — clicking it would delete it (routed
// to remote by the ownership check above, since the Mac never has that account
// locally). `listProviders` merges too, so that metadata reaches every host that
// can show a remote account.
test('accounts.listProviders unions the catalog, deduped by id (this side wins)', async () => {
	const vol = volume(memStorage())
	// This host's own catalog lacks the cloud-only built-in — the real shape of the
	// Mac daemon.
	const { accounts } = accountsCapabilities([icloudProvider()], vol)
	const cloudProviders = [
		{ id: 'frieren', name: 'Kodama', authKind: 'none', builtin: true, capabilities: ['ai'] },
		// Same id as the local catalog's — the collision case.
		{ id: 'icloud', name: 'iCloud (cloud copy)', authKind: 'form', capabilities: ['calendar'] }
	]
	const remote: Capabilities = {
		invoke: async () => cloudProviders,
		subscribe: async () => () => {}
	}
	const caps = settingsHost({ accounts, remote })

	const providers = (await caps.invoke(call('accounts.listProviders'))) as {
		id: string
		name: string
		builtin?: boolean
	}[]
	expect(providers.map((p) => p.id).sort()).toEqual(['frieren', 'icloud'])
	expect(providers.find((p) => p.id === 'frieren')?.builtin).toBe(true)
	// The local `icloud` entry wins — not the remote's same-id one.
	expect(providers.filter((p) => p.id === 'icloud')).toHaveLength(1)
	expect(providers.find((p) => p.id === 'icloud')?.name).not.toBe('iCloud (cloud copy)')
})

test('with only the local lane configured (no remote), the list is local alone — unchanged', async () => {
	// The DO's own shape today: `accounts` with no `remote`.
	const caps = host()
	await caps.invoke(
		call('accounts.connect', {
			providerId: 'icloud',
			credentials: { username: 'u@me.com', password: 'p' }
		})
	)
	const list = (await caps.invoke(call('accounts.listAccounts'))) as { accountId: string }[]
	expect(list.map((a) => a.accountId)).toEqual(['u@me.com'])
})

test('connect/setEnabled/disconnect stay routed to the local dep, never the remote', async () => {
	const forwarded: CapabilityCall[] = []
	const remote: Capabilities = {
		invoke: async (c) => {
			forwarded.push(c)
			return []
		},
		subscribe: async () => () => {}
	}
	const caps = host({ remote })
	await caps.invoke(call('accounts.connect', { providerId: 'frieren' }))
	await caps.invoke(
		call('accounts.setEnabled', { accountId: 'frieren', capability: 'ai', enabled: true })
	)
	await caps.invoke(call('accounts.disconnect', { accountId: 'frieren' }))
	// `frieren` was connected locally, so setEnabled/disconnect find it in the local
	// store and never reach `remote` — only the ownership check (a local read) ran.
	// (`listProviders`/`listAccounts` DO reach remote — that's the read union, tested
	// separately — so this only exercises the three write methods.)
	expect(forwarded).toEqual([])
})

// The merged list (above) can show an account this host does NOT own — mutating one
// must reach whichever side actually has it, or a cloud account becomes untoggleable
// (setEnabled: CAPABILITY_INVALID_INPUT) or, worse, silently un-disconnectable (a
// `rm --force` on a path that was never there).
test('setEnabled on a cloud-only account routes to remote, not the local store', async () => {
	const forwarded: CapabilityCall[] = []
	const remote: Capabilities = {
		invoke: async (c) => {
			forwarded.push(c)
			return undefined
		},
		subscribe: async () => () => {}
	}
	const caps = host({ remote }) // local store starts empty — nothing is "mine"
	await caps.invoke(
		call('accounts.setEnabled', { accountId: 'g@gmail.com', capability: 'email', enabled: true })
	)
	expect(forwarded).toEqual([
		call('accounts.setEnabled', { accountId: 'g@gmail.com', capability: 'email', enabled: true })
	])
})

test('disconnect on a cloud-only account routes to remote, not a local no-op', async () => {
	const forwarded: CapabilityCall[] = []
	const remote: Capabilities = {
		invoke: async (c) => {
			forwarded.push(c)
			return undefined
		},
		subscribe: async () => () => {}
	}
	const caps = host({ remote })
	await caps.invoke(call('accounts.disconnect', { accountId: 'g@gmail.com' }))
	expect(forwarded).toEqual([call('accounts.disconnect', { accountId: 'g@gmail.com' })])
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

// ── agent.* ───────────────────────────────────────────────────────────────
// The identity files are the Volume's, so these run against a real one. The paths are
// injected (they belong to `@justfiles/agent`, which depends on this package), so what
// is asserted here is that the host honours the paths it was handed — every wiring
// passes the one `IDENTITY_PATHS` symbol.

const PATHS = {
	soul: '/system/agents/main/soul.md',
	avatars: '/system/agents/main/avatars',
	profile: '/system/user.md'
}

// The art the app ships, injected for the same reason the paths are (it lives in
// `@justfiles/agent`, which depends on this package). Two states, so `files` has something
// to report and the pane has a list of states to offer.
const BUILTINS = {
	vanilla: { resting: 'data:image/png;base64,AA', states: ['resting', 'pleased'] }
}

function agentHost(over: Partial<SettingsHostDeps['agent']> = {}) {
	const vol = volume(memStorage())
	const { accounts } = accountsCapabilities([icloudProvider()], vol)
	return {
		vol,
		caps: settingsHost({
			accounts,
			agent: { volume: vol, paths: PATHS, builtins: BUILTINS, ...over }
		})
	}
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const encode = (text: string) => new TextEncoder().encode(text)
// Real signatures: what a state IS is read from its bytes, never from its name.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const WEBP = new Uint8Array([...encode('RIFF'), 0, 0, 0, 0, ...encode('WEBP')])

test('agent.writeSoul then readSoul round-trips, through the paths the host was handed', async () => {
	const { vol, caps } = agentHost()
	await caps.invoke(
		call('agent.writeSoul', { name: 'Fern', gender: 'female', body: 'You are Fern.' })
	)
	expect(await caps.invoke(call('agent.readSoul'))).toEqual({
		name: 'Fern',
		gender: 'female',
		avatar: null,
		body: 'You are Fern.',
		seeded: false
	})
	// The file, not just the projection: the pane holds no path and no format.
	const text = decode(await vol.readFile(PATHS.soul))
	expect(text).toContain('schema: frieren/agent-soul/v1')
	expect(text).toContain('agent_name: Fern')
	expect(text).toContain('agent_gender: female')
	// Writing clears the seeded flag: this soul is the user's now.
	expect(text).not.toContain('seeded')
	expect(text.trimEnd().endsWith('You are Fern.')).toBe(true)
})

test('the seeded default reads as unbound, so the pane can send you to the summoning', async () => {
	const { vol, caps } = agentHost()
	// What the agent identity owner seeds on first agent access (kept as a literal: this asserts the
	// reading of a seeded file, not the seeder).
	await vol.mkdir('/system/agents/main', { recursive: true })
	await vol.writeFile(
		PATHS.soul,
		encode(
			'---\nschema: frieren/agent-soul/v1\nagent_name: Kodama\nseeded: true\n---\n\nYou are Kodama.\n'
		)
	)
	expect(await caps.invoke(call('agent.readSoul'))).toMatchObject({
		name: 'Kodama',
		seeded: true
	})
	// A volume where nothing was ever seeded is the same user-visible state.
	const virgin = agentHost()
	expect(await virgin.caps.invoke(call('agent.readSoul'))).toMatchObject({
		name: '',
		seeded: true
	})
})

test('a nature is never recorded — only the avatar it chose', async () => {
	const { vol, caps } = agentHost()
	await caps.invoke(
		call('agent.writeSoul', {
			name: 'Fern',
			gender: 'female',
			body: 'You teach by asking.',
			avatar: 'builtin/teacher'
		})
	)
	expect(await caps.invoke(call('agent.readSoul'))).toMatchObject({ avatar: 'builtin/teacher' })
	// The nature itself leaves no trace: the prose is the character, so a word claiming
	// otherwise could only ever disagree with it. What is recorded is a SOURCE for the art,
	// which for a built-in means no bytes on the volume at all.
	const text = decode(await vol.readFile(PATHS.soul))
	expect(text).not.toContain('archetype')
	expect(text).toContain('avatar: builtin/teacher')
	// A plain write keeps them dressed: the avatar is an ordinary patch field, so a rename
	// preserves it without anyone restating a rule about who may choose one.
	await caps.invoke(call('agent.writeSoul', { name: 'Frieren', gender: 'female', body: 'Same.' }))
	expect(await caps.invoke(call('agent.readSoul'))).toMatchObject({
		name: 'Frieren',
		avatar: 'builtin/teacher'
	})
})

test('a soul write is a patch: a rename never carries an unfinished edit with it', async () => {
	// The sheet edits one field at a time — a rename saves on blur, the prose only when you
	// press Done — so a write that carried the whole sheet would commit the editor's
	// unfinished text every time the name or the gender was saved.
	const { caps } = agentHost()
	await caps.invoke(
		call('agent.writeSoul', {
			name: 'Fern',
			gender: 'female',
			body: 'You are Fern.',
			avatar: 'builtin/companion'
		})
	)
	await caps.invoke(call('agent.writeSoul', { name: 'Frieren' }))
	expect(await caps.invoke(call('agent.readSoul'))).toEqual({
		name: 'Frieren',
		gender: 'female',
		avatar: 'builtin/companion',
		body: 'You are Fern.',
		seeded: false
	})
})

test('an avatar is a directory: listAvatars shows the bundle then the volume', async () => {
	const { vol, caps } = agentHost()
	// Nothing installed yet: the built-in art alone, and it costs the volume nothing.
	expect(await caps.invoke(call('agent.listAvatars'))).toEqual([
		{
			ref: 'builtin/vanilla',
			label: 'Vanilla',
			builtin: true,
			preview: 'data:image/png;base64,AA',
			files: ['resting', 'pleased']
		}
	])

	// One file per state, and the first one brings the avatar into being. A state may be
	// stored in any format — this one wears a WebP resting face, as a browser that can encode
	// WebP produces — and the file is named for the STATE either way.
	await caps.invoke(call('agent.putAvatarFile', { avatar: 'mine', name: 'resting', bytes: WEBP }))
	await caps.invoke(call('agent.putAvatarFile', { avatar: 'mine', name: 'pleased', bytes: PNG }))
	const [, mine] = (await caps.invoke(call('agent.listAvatars'))) as AvatarInfo[]
	expect(mine).toMatchObject({ ref: 'mine', label: 'Mine', builtin: false })
	expect(mine?.files).toEqual(['pleased', 'resting'])
	expect(mine?.preview.startsWith('data:image/webp;base64,')).toBe(true)

	// Null bytes DELETE that state — the artist's file goes, the avatar stays.
	await caps.invoke(call('agent.putAvatarFile', { avatar: 'mine', name: 'pleased', bytes: null }))
	const [, after] = (await caps.invoke(call('agent.listAvatars'))) as AvatarInfo[]
	expect(after?.files).toEqual(['resting'])

	// Derived art is the model's lane, and a directory with no resting state is not an
	// avatar yet: neither shows up as one to wear.
	await vol.mkdir(`${PATHS.avatars}/mine/.gen/abc`, { recursive: true })
	await vol.writeFile(`${PATHS.avatars}/mine/.gen/abc/curious.png`, PNG)
	await vol.mkdir(`${PATHS.avatars}/half`, { recursive: true })
	await vol.writeFile(`${PATHS.avatars}/half/pleased.png`, PNG)
	// And one whose resting bytes are not an image at all: also not offered, rather than
	// offered as a broken portrait.
	await vol.mkdir(`${PATHS.avatars}/broken`, { recursive: true })
	await vol.writeFile(`${PATHS.avatars}/broken/resting.png`, encode('not an image'))
	const list = (await caps.invoke(call('agent.listAvatars'))) as AvatarInfo[]
	expect(list.map((a) => a.ref)).toEqual(['builtin/vanilla', 'mine'])
	expect(list[1]?.files).toEqual(['resting'])
})

test('an avatar is offered when ANY file claiming resting can be rendered', async () => {
	// The exact shape that made two readers disagree: `resting.aaa` sorts first and is not
	// art, so a picker that stopped there would hide an avatar the shell happily wears. Both
	// sides resolve through `readImageFile`, so there is one answer.
	const { vol, caps } = agentHost()
	await vol.mkdir(`${PATHS.avatars}/pack`, { recursive: true })
	await vol.writeFile(`${PATHS.avatars}/pack/resting.aaa`, encode('not art'))
	await vol.writeFile(`${PATHS.avatars}/pack/resting.webp`, WEBP)
	const [, pack] = (await caps.invoke(call('agent.listAvatars'))) as AvatarInfo[]
	expect(pack?.ref).toBe('pack')
	expect(pack?.preview.startsWith('data:image/webp;base64,')).toBe(true)
})

test('no step of a publish can lose the state the user is wearing', async () => {
	// EVERY fallible step runs while the old file is still on the volume: the bytes land under
	// a name nothing resolves, the rename makes them the state, and only then is the file they
	// replaced taken out. Sweeping first would cost the user their portrait for good on the one
	// run where the rename failed — and it is the same file either way, so there is nothing to
	// restore it from.
	const vol = volume(memStorage())
	let fail: 'write' | 'rename' | null = null
	const caps = settingsHost({
		agent: {
			paths: PATHS,
			builtins: BUILTINS,
			volume: Object.assign(Object.create(vol), {
				writeFile: (path: string, data: Uint8Array) =>
					fail === 'write' ? Promise.reject(new Error('ENOSPC')) : vol.writeFile(path, data),
				rename: (from: string, to: string) =>
					fail === 'rename' ? Promise.reject(new Error('EIO')) : vol.rename(from, to)
			})
		}
	})
	// A pack's PNG — a file the replacement does NOT write over, which is the case where an
	// early sweep leaves nothing behind.
	await vol.mkdir(`${PATHS.avatars}/mine`, { recursive: true })
	await vol.writeFile(`${PATHS.avatars}/mine/resting.png`, PNG)

	for (const step of ['write', 'rename'] as const) {
		fail = step
		await expect(
			caps.invoke(call('agent.putAvatarFile', { avatar: 'mine', name: 'resting', bytes: WEBP }))
		).rejects.toThrow()
		// Still exactly the portrait they had, and nothing staged is offered as a state.
		const [, mine] = (await caps.invoke(call('agent.listAvatars'))) as AvatarInfo[]
		expect(mine?.files).toEqual(['resting.png'])
		expect(mine?.preview.startsWith('data:image/png;base64,')).toBe(true)
	}

	// And when it goes through, the file it replaced goes with it.
	fail = null
	await caps.invoke(call('agent.putAvatarFile', { avatar: 'mine', name: 'resting', bytes: WEBP }))
	const [, mine] = (await caps.invoke(call('agent.listAvatars'))) as AvatarInfo[]
	expect(mine?.files).toEqual(['resting'])
	expect(mine?.preview.startsWith('data:image/webp;base64,')).toBe(true)
})

test('a write claims a STATE at ONE path, so one state can never be stored twice', async () => {
	// The uniqueness a state needs is not the one a filesystem gives: `resting` is the key, but
	// `resting.png` is the name. Two rules make that hold, and the second is what a filesystem
	// alone cannot do — the published file IS the state, so its name cannot vary with the
	// encoder the device happened to have (WebP here, PNG on a Safari that syncs with it), and
	// every other file claiming that state is swept, whatever a pack called it.
	const { vol, caps } = agentHost()
	const dir = `${PATHS.avatars}/mine`
	await vol.mkdir(dir, { recursive: true })
	await vol.writeFile(`${dir}/resting.webp`, WEBP)

	// The pane may ask by the name it is showing; what lands is the state.
	await caps.invoke(
		call('agent.putAvatarFile', { avatar: 'mine', name: 'resting.webp', bytes: PNG })
	)
	expect((await vol.readdir(dir)).map((e) => e.name)).toEqual(['resting'])
	// The same state published again in another format — the path a second device would write
	// to as well, so sync has one file to converge on instead of two nothing reconciles.
	await caps.invoke(call('agent.putAvatarFile', { avatar: 'mine', name: 'resting', bytes: WEBP }))
	expect((await vol.readdir(dir)).map((e) => e.name)).toEqual(['resting'])

	// And a DELETE drops the state in whatever format it is stored, so the pane can ask by
	// the name it happens to be showing.
	await caps.invoke(
		call('agent.putAvatarFile', { avatar: 'mine', name: 'resting.jpg', bytes: null })
	)
	expect(await vol.readdir(dir)).toEqual([])
})

test('putAvatarFile writes ONE file in ONE avatar, and nowhere else', async () => {
	const { caps } = agentHost()
	const bytes = new Uint8Array([1])
	for (const bad of [
		{ avatar: '../..', name: 'resting.png' },
		{ avatar: 'mine', name: '../soul.md' },
		{ avatar: 'mine', name: '.gen' },
		{ avatar: '.gen', name: 'resting.png' },
		{ avatar: '', name: 'resting.png' },
		{ avatar: 'mine', name: '' }
	]) {
		await expect(caps.invoke(call('agent.putAvatarFile', { ...bad, bytes }))).rejects.toMatchObject(
			{ code: 'CAPABILITY_INVALID_INPUT' }
		)
	}
})

test('agent.readProfile / writeProfile carry only what the user chose to say', async () => {
	const { caps } = agentHost()
	expect(await caps.invoke(call('agent.readProfile'))).toMatchObject({ name: '' })
	await caps.invoke(
		call('agent.writeProfile', { name: 'Xiaoxing', birthDate: '1985-04-12', gender: 'male' })
	)
	expect(await caps.invoke(call('agent.readProfile'))).toEqual({
		name: 'Xiaoxing',
		birthDate: '1985-04-12',
		gender: 'male'
	})
})

test('agent.generateSoul is a preview: it reads the user from the volume and writes nothing', async () => {
	const seen: unknown[] = []
	const { caps } = agentHost({
		generateSoul: async (input) => {
			seen.push(input)
			return { body: 'A drafted soul.', firstWords: 'I am here.' }
		}
	})
	await caps.invoke(
		call('agent.writeProfile', { name: 'Xiaoxing', birthDate: '1985-04-12', gender: 'male' })
	)
	expect(
		await caps.invoke(
			call('agent.generateSoul', { name: 'Fern', gender: 'female', archetype: 'companion' })
		)
	).toEqual({ body: 'A drafted soul.', firstWords: 'I am here.' })
	// The host supplies who the user is, so no consumer derives an age from a date.
	expect(seen).toMatchObject([
		{ name: 'Fern', gender: 'female', archetype: 'companion', userGender: 'male' }
	])
	expect((seen[0] as { userAge: number }).userAge).toBeGreaterThan(30)
	// A preview never lands on the volume.
	expect(await caps.invoke(call('agent.readSoul'))).toMatchObject({ seeded: true })
})

test("an age is counted in the USER's calendar, not the host's", async () => {
	// The frieren host is a worker on UTC while the user is somewhere else, so "today" has
	// to come from their timezone: at 17:00 in Los Angeles it is already tomorrow in UTC,
	// and a birthday tomorrow would otherwise count itself as already past.
	const seen: { userAge?: number }[] = []
	// Los Angeles is a day behind UTC late in its evening; pick the moment deliberately.
	const now = new Date('2026-08-01T03:00:00Z') // = 2026-07-31 20:00 in Los Angeles
	vi.setSystemTime(now)
	try {
		const { caps } = agentHost({
			timezone: () => 'America/Los_Angeles',
			generateSoul: async (input) => {
				seen.push(input)
				return { body: 'A drafted soul.' }
			}
		})
		// Their 30th birthday is 2026-08-01 — tomorrow where they are, today in UTC.
		await caps.invoke(call('agent.writeProfile', { name: 'X', birthDate: '1996-08-01' }))
		await caps.invoke(
			call('agent.generateSoul', { name: 'Fern', gender: 'female', archetype: 'companion' })
		)
		expect(seen[0]?.userAge).toBe(29)
	} finally {
		vi.useRealTimers()
	}
})

test("generation prefers the caller's facts: the generator need not run where they live", async () => {
	// In the browser this call is served by the Durable Object, whose copy of `user.md` is
	// a sync behind the one the user just typed into — so the caller sends what it read.
	const seen: { userAge?: number; userGender?: string }[] = []
	const { caps } = agentHost({
		generateSoul: async (input) => {
			seen.push(input)
			return { body: 'A drafted soul.' }
		}
	})
	// What THIS volume knows is deliberately different from what the caller sends.
	await caps.invoke(call('agent.writeProfile', { birthDate: '1985-04-12', gender: 'male' }))
	await caps.invoke(
		call('agent.generateSoul', {
			name: 'Fern',
			gender: 'female',
			archetype: 'companion',
			user: { birthDate: '2016-04-12', gender: 'female' }
		})
	)
	expect(seen[0]?.userGender).toBe('female')
	expect(seen[0]?.userAge).toBeLessThan(20)
})

test('a profile write is a patch: it never puts back a field it was not given', async () => {
	// The pane saves per field as you edit, so a whole-profile write let a slower save
	// restore the value a faster one had just changed.
	const { caps } = agentHost({})
	await caps.invoke(
		call('agent.writeProfile', { name: 'Xiaoxing', birthDate: '1985-04-12', gender: 'male' })
	)
	await caps.invoke(call('agent.writeProfile', { gender: 'female' }))
	expect(await caps.invoke(call('agent.readProfile'))).toEqual({
		name: 'Xiaoxing',
		birthDate: '1985-04-12',
		gender: 'female'
	})
})

test('no generator is UNAVAILABLE (a mac-shaped host), and the Volume methods still work', async () => {
	const { caps } = agentHost()
	await expect(
		caps.invoke(call('agent.generateSoul', { name: 'F', gender: 'female', archetype: 'companion' }))
	).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
	await expect(caps.invoke(call('agent.readSoul'))).resolves.toBeTruthy()
})

test('no volume: every agent.* method is UNAVAILABLE rather than half-served', async () => {
	const caps = host()
	for (const method of AGENT_METHODS) {
		await expect(caps.invoke(call(method, {}))).rejects.toMatchObject({
			code: 'CAPABILITY_UNAVAILABLE'
		})
	}
})

test('a non-allowlisted app is refused every agent.* method', async () => {
	const { caps } = agentHost({ generateSoul: async () => ({ body: 'x' }) })
	for (const method of AGENT_METHODS) {
		await expect(caps.invoke(call(method, {}, 'app.someone.else'))).rejects.toMatchObject({
			code: 'CAPABILITY_UNAVAILABLE'
		})
	}
})

// ── appearance.* ──────────────────────────────────────────────────────────
// A wallpaper is ONE file on the Volume, read and written whole. What is asserted here is
// the host's only judgement — the bytes must be an image — plus the two shapes of null:
// unset reads as null, and writing null puts the desktop back on the shell's default.

const WALLPAPER = '/system/wallpaper'

function appearanceHost() {
	const vol = volume(memStorage())
	return { vol, caps: settingsHost({ appearance: { volume: vol, wallpaper: WALLPAPER } }) }
}

test('appearance.* round-trips the wallpaper bytes at the path the host was handed', async () => {
	const { vol, caps } = appearanceHost()
	// Nothing set yet is null, not an error: the shell is on its own default.
	expect(await caps.invoke(call('appearance.readWallpaper'))).toBeNull()

	await caps.invoke(call('appearance.writeWallpaper', { bytes: PNG }))
	expect(await vol.readFile(WALLPAPER)).toEqual(PNG)
	expect(await caps.invoke(call('appearance.readWallpaper'))).toEqual(PNG)

	// A flat colour is bytes too — the SVG the Settings app writes for one. The host does
	// not know a colour from a photograph, which is what keeps this two methods.
	const svg = encode('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#23262a"/></svg>')
	await caps.invoke(call('appearance.writeWallpaper', { bytes: svg }))
	expect(await caps.invoke(call('appearance.readWallpaper'))).toEqual(svg)

	// null removes the file, so the desktop falls back the same way it does on a device
	// where nobody ever set one.
	await caps.invoke(call('appearance.writeWallpaper', { bytes: null }))
	expect(await vol.exists(WALLPAPER)).toBe(false)
	expect(await caps.invoke(call('appearance.readWallpaper'))).toBeNull()
})

test('bytes that are not an image are refused, so a desktop cannot be broken by a write', async () => {
	const { vol, caps } = appearanceHost()
	await expect(
		caps.invoke(call('appearance.writeWallpaper', { bytes: encode('%PDF-1.7') }))
	).rejects.toMatchObject({ code: 'CAPABILITY_INVALID_INPUT' })
	expect(await vol.exists(WALLPAPER)).toBe(false)
})

test('no wallpaper on this shell: appearance.* is UNAVAILABLE, not half-served', async () => {
	const caps = host()
	for (const method of ['appearance.readWallpaper', 'appearance.writeWallpaper']) {
		await expect(caps.invoke(call(method, { bytes: null }))).rejects.toMatchObject({
			code: 'CAPABILITY_UNAVAILABLE'
		})
	}
})

test('a non-allowlisted app is refused the wallpaper too', async () => {
	const { caps } = appearanceHost()
	await expect(
		caps.invoke(call('appearance.readWallpaper', {}, 'app.someone.else'))
	).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
})

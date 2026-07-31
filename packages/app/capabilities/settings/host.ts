// How a host serves `settings`. This file composes what already exists — the accounts
// admin impl, a usage thunk, an identity thunk — and implements no admin logic itself.
// Three things make it unlike the other capability hosts:
//
//  • THE GATE IS APP IDENTITY. One allowlist check covers every method, reported as
//    UNAVAILABLE (not DENIED) so a non-first-party app cannot tell the capability
//    exists. The list lives here, once, for every host — the contract's rule 2 (single
//    consumer, forever) is what keeps it a constant.
//  • A METHOD IS SERVED WHERE ITS DEP IS. Each method runs locally when its dep is
//    wired, is delegated to `remote` if the host gave one, and is UNAVAILABLE if it did
//    not. That one rule covers all three hosts: the frieren browser half wires `user`
//    and delegates `accounts.*`/`host.usage` to the DO (credentials live under
//    `/private/**`, which never replicates), the DO wires both and delegates nothing,
//    and the Mac daemon wires `accounts` only — so its Usage pane hides itself.
//  • THE READ UNION: `listAccounts` CONCATENATES, `listProviders` DEDUPES.
//    A signed-in device can hold accounts in BOTH lanes at once — some connected
//    directly on it, some owned by the cloud and reached through `remote` (#305) —
//    and the user expects to see all of them in one Settings list, each tagged by
//    `AccountInfo.origin` (#296). So when `accounts` AND `remote` are both
//    configured, `listAccounts` fans out to both and concatenates (accounts never
//    collide across hosts). `listProviders` fans out too, but DEDUPES by id
//    (this side wins on a collision, e.g. both may offer 'google') — a remote-only
//    entry still has to reach here, because a merged account's `ProviderInfo` (in
//    particular `builtin`) has to be resolvable on THIS side too, or Settings can't
//    tell a remote built-in account from an ordinary one and renders a Disconnect
//    button for it (see the mutation-routing note below — that button is live).
//  • MUTATING BY OWNER. The merged list can show an account this side does NOT
//    own, so mutating one (`setEnabled`/`disconnect`) first checks whether the
//    local store actually has it — local if so, `remote` if not (D1: administer an
//    account where it lives). `connect` needs no such check: it creates a NEW
//    account, always on this side. With only one lane configured, every check above
//    is a no-op — unchanged from before any of this existed.

import { CapabilityError } from '../error.ts'
import type { Capabilities, Capability } from '../types.ts'
import type {
	AccountsAdmin,
	AgentSoul,
	GeneratedSoul,
	ProviderInfo,
	SettingsCapability,
	UsageSnapshot,
	UserFacts,
	UserProfile
} from './contract.ts'

// The one identity gate. Not a scope: a declared scope would hand the host admin
// surface to any sideloaded app that declares `settings`.
export const SETTINGS_ALLOWLIST = new Set(['app.justfiles.frieren.settings'])

// Where the host reads usage from (the frieren DO's per-user meter + quota) and who
// is signed in (Clerk in the browser; the native account later). Thunks, so every
// call reflects the CURRENT counters/session — a sign-in is picked up on the next call.
export type GetUsage = () => UsageSnapshot | Promise<UsageSnapshot>
export type GetUser = () => UserProfile | null | Promise<UserProfile | null>

// What a soul generator is asked. The user facts come from the profile ON THE VOLUME,
// added here, so no consumer derives an age from a birth date.
export interface SoulDraftInput {
	name: string
	gender: 'female' | 'male'
	archetype: string
	userAge?: number
	userGender?: string
}

// The minimum a host needs to serve `agent.*`: the Volume the identity files live on,
// and where they live. The paths are INJECTED rather than imported because they belong
// to `@justfiles/agent`, which depends on this package — one symbol
// (`IDENTITY_PATHS`) is passed by every wiring, so there is still exactly one
// definition of where a soul lives.
export interface IdentityPaths {
	soul: string
	avatar: string
	profile: string
}

// A minimal Volume: only what the identity files need. Typed structurally so this
// package keeps its single `@justfiles/fs` import for the real thing.
interface IdentityVolume {
	exists(path: string): Promise<boolean>
	readFile(path: string): Promise<Uint8Array>
	writeFile(path: string, data: Uint8Array): Promise<void>
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
	rm(path: string, options?: { force?: boolean }): Promise<void>
}

export interface AgentDeps {
	volume: IdentityVolume
	paths: IdentityPaths
	// Absent on a host with no text model to spare (and on the browser half, which
	// delegates to the DO): `agent.generateSoul` is then UNAVAILABLE, which the pane
	// reads as "write it yourself".
	generateSoul?: (input: SoulDraftInput) => Promise<GeneratedSoul>
}

export interface SettingsHostDeps {
	accounts?: AccountsAdmin
	usage?: GetUsage
	user?: GetUser
	// The agent's identity files, where the Volume is (both hosts).
	agent?: AgentDeps
	// Where a method this host cannot serve goes (the browser half → the DO).
	remote?: Capabilities
}

// The methods this host serves. A missing key is the "not here" signal the
// dispatcher routes on, so the split is derived from the deps, never restated.
type Served = { [K in keyof SettingsCapability]?: SettingsCapability[K] }

export function settingsHost(deps: SettingsHostDeps): Capability {
	const { accounts, usage, user, agent, remote } = deps
	const served: Served = {
		...(accounts && {
			'accounts.listProviders': (i) => accounts.listProviders(i),
			'accounts.listAccounts': (i) => accounts.listAccounts(i),
			'accounts.connect': (i) => accounts.connect(i),
			'accounts.setEnabled': (i) => accounts.setEnabled(i),
			'accounts.disconnect': (i) => accounts.disconnect(i)
		}),
		...(usage && { 'host.usage': async () => usage() }),
		...(agent && agentMethods(agent)),
		// Always local, even with no dep: "no one is signed in" is an answer, not an
		// error, and identity lives where the session does.
		'host.user': async () => (await user?.()) ?? null
	}
	const unavailable = (method: string) =>
		new CapabilityError('CAPABILITY_UNAVAILABLE', 'settings', method)
	// Does THIS host's own store have `accountId`? The merged list can show an account
	// this side doesn't own, so a mutation checks before running — see the file header.
	const ownsLocally = async (accountId: string): Promise<boolean> =>
		!!accounts && (await accounts.listAccounts({})).some((a) => a.accountId === accountId)
	return {
		invoke: async (call) => {
			if (!SETTINGS_ALLOWLIST.has(call.appId)) throw unavailable(call.method)
			// The read union (see the file header): both lanes configured ⇒ both queried.
			// One lane configured ⇒ that lane alone, unchanged from before this existed
			// (the DO has no `remote`; the browser has no `accounts`).
			if (call.method === 'accounts.listAccounts' && accounts && remote) {
				const [local, cloud] = await Promise.all([
					accounts.listAccounts(...(call.args as [Record<string, never>])),
					remote.invoke(call) as Promise<unknown[]>
				])
				return [...local, ...cloud]
			}
			if (call.method === 'accounts.listProviders' && accounts && remote) {
				const [local, cloud] = await Promise.all([
					accounts.listProviders(...(call.args as [Record<string, never>])),
					remote.invoke(call) as Promise<ProviderInfo[]>
				])
				const ids = new Set(local.map((p) => p.id))
				return [...local, ...cloud.filter((p) => !ids.has(p.id))]
			}
			// Mutating an EXISTING account by id must reach whichever side actually owns
			// it: `setEnabled`/`disconnect` route local only when the local store has the
			// account, remote otherwise — a no-op (both configured) when it's neither.
			if (
				(call.method === 'accounts.setEnabled' || call.method === 'accounts.disconnect') &&
				accounts &&
				remote
			) {
				const { accountId } = call.args[0] as { accountId: string }
				if (!(await ownsLocally(accountId))) return remote.invoke(call)
			}
			const method = served[call.method as keyof SettingsCapability]
			// The frame rides on unchanged, so the far end gates on the same appId.
			if (!method) {
				if (remote) return remote.invoke(call)
				throw unavailable(call.method)
			}
			return (method as (...args: readonly unknown[]) => Promise<unknown>)(...call.args)
		},
		// No streams: nothing on the admin surface is push-shaped.
		subscribe: async (call) => {
			throw unavailable(call.method)
		}
	}
}

// ── the agent's identity files ────────────────────────────────────────────
// The one place these files are parsed and written. Before this, three copies of the
// same frontmatter parse existed (the worker's, the shell's, the personalize flow's);
// consumers now get a projection and never see markdown.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type Frontmatter = Record<string, string>

function parse(text: string): { frontmatter: Frontmatter; body: string } {
	const match = text.match(/^---\n([\s\S]*?)\n---(?:\n+([\s\S]*))?$/)
	if (!match?.[1]) return { frontmatter: {}, body: text.trim() }
	const frontmatter: Frontmatter = {}
	for (const line of match[1].split('\n')) {
		const idx = line.indexOf(':')
		if (idx === -1) continue
		const key = line.slice(0, idx).trim()
		if (key) frontmatter[key] = line.slice(idx + 1).trim()
	}
	return { frontmatter, body: (match[2] ?? '').trim() }
}

// One line per key, in the order given, then the prose. A value never spans lines —
// a pasted newline would silently become frontmatter.
function serialize(frontmatter: [string, string | null][], body?: string): Uint8Array {
	const lines = ['---']
	for (const [key, value] of frontmatter) {
		if (value !== null && value !== '') lines.push(`${key}: ${value.replace(/[\r\n]+/g, ' ')}`)
	}
	lines.push('---', '')
	if (body !== undefined) lines.push(body.trim(), '')
	return encoder.encode(lines.join('\n'))
}

// GENDER IS FEMALE OR MALE. That is the product's answer, not an unfinished picker:
// there are two segments in the UI, two values in the frontmatter, and nothing to
// normalise. Any other value a file happens to carry reads as null and is not preserved.
//
// NO BACKWARD COMPATIBILITY, HERE OR ANYWHERE (see CLAUDE.md). This product has a
// handful of users; a changed file shape is simply the new shape, and old values are not
// migrated, mirrored or kept alive. Reviewers: that is deliberate, not data loss.
function gender(value?: string): 'female' | 'male' | null {
	return value === 'female' || value === 'male' ? value : null
}

async function read(
	vol: IdentityVolume,
	path: string
): Promise<{ frontmatter: Frontmatter; body: string }> {
	// A missing file is the same user-visible state as an untouched seeded one: unbound.
	if (!(await vol.exists(path))) return { frontmatter: { seeded: 'true' }, body: '' }
	return parse(decoder.decode(await vol.readFile(path)))
}

// `writeFile` does not create parents, and after a wipe even `/system` is gone.
async function writeTo(vol: IdentityVolume, path: string, bytes: Uint8Array): Promise<void> {
	const parent = path.slice(0, path.lastIndexOf('/')) || '/'
	await vol.mkdir(parent, { recursive: true })
	await vol.writeFile(path, bytes)
}

function age(birthDate: string): number | undefined {
	const birth = new Date(birthDate)
	if (!birthDate || Number.isNaN(birth.getTime())) return undefined
	const now = new Date()
	const years = now.getFullYear() - birth.getFullYear()
	const before =
		now.getMonth() < birth.getMonth() ||
		(now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())
	return before ? years - 1 : years
}

function agentMethods({ volume: vol, paths, generateSoul }: AgentDeps): Served {
	const readSoul = async (): Promise<AgentSoul> => {
		const { frontmatter, body } = await read(vol, paths.soul)
		return {
			name: frontmatter.agent_name ?? '',
			gender: gender(frontmatter.agent_gender),
			archetype: frontmatter.archetype ?? null,
			avatarVariant: frontmatter.avatar_variant ?? null,
			body,
			seeded: frontmatter.seeded === 'true'
		}
	}
	const readProfile = async (): Promise<UserFacts> => {
		const { frontmatter } = await read(vol, paths.profile)
		return {
			name: frontmatter.name ?? '',
			birthDate: frontmatter.birth_date ?? '',
			gender: gender(frontmatter.gender),
			seeded: frontmatter.seeded === 'true'
		}
	}
	return {
		'agent.readSoul': readSoul,
		'agent.writeSoul': async ({ name, gender: sex, body, archetype }) => {
			const current = await readSoul()
			// The archetype (and the art it points at) is the summoning's to set: a plain
			// write preserves what was recorded, because the prose is the character now.
			const seed = archetype ?? current.archetype
			const variant = archetype ?? current.avatarVariant
			await writeTo(
				vol,
				paths.soul,
				serialize(
					[
						['schema', 'frieren/agent-soul/v1'],
						['agent_name', name],
						['agent_gender', sex],
						['archetype', seed],
						['avatar_variant', variant]
					],
					body
				)
			)
		},
		'agent.readAvatar': async () =>
			(await vol.exists(paths.avatar)) ? vol.readFile(paths.avatar) : null,
		'agent.writeAvatar': async ({ bytes }) => {
			// Null DELETES: `avatar.png` is what decides the face, so leaving stale bytes
			// behind would keep beating the built-in art the soul now names.
			if (!bytes) return vol.rm(paths.avatar, { force: true })
			await writeTo(vol, paths.avatar, bytes)
		},
		'agent.readProfile': readProfile,
		'agent.writeProfile': async ({ name, birthDate, gender: sex }) => {
			await writeTo(
				vol,
				paths.profile,
				serialize([
					['schema', 'frieren/user-profile/v1'],
					['name', name],
					['birth_date', birthDate],
					['gender', sex]
				])
			)
		},
		...(generateSoul && {
			// A PREVIEW. The user facts ride along from the volume, so the pane sends only
			// what it actually collected.
			'agent.generateSoul': async ({ name, gender: sex, archetype }) => {
				const facts = await readProfile()
				return generateSoul({
					name,
					gender: sex,
					archetype,
					userAge: age(facts.birthDate),
					userGender: facts.gender ?? undefined
				})
			}
		})
	}
}

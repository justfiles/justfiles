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

import { fileStem, imageDataUrl, imageFileNames, readImageFile } from '../../image-type.ts'
import { CapabilityError } from '../error.ts'
import type { Capabilities, Capability } from '../types.ts'
import type {
	AccountsAdmin,
	AgentSoul,
	AvatarInfo,
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
	// The summoning's seed, and only the summoning's — a rewrite sends none.
	archetype?: string
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
	// The directory the agent's avatars live in — one subdirectory per avatar.
	avatars: string
	profile: string
}

// A minimal Volume: only what the identity files need. Typed structurally so this
// package keeps its single `@justfiles/fs` import for the real thing.
interface IdentityVolume {
	exists(path: string): Promise<boolean>
	readFile(path: string): Promise<Uint8Array>
	writeFile(path: string, data: Uint8Array): Promise<void>
	readdir(path: string): Promise<{ name: string }[]>
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
	rm(path: string, options?: { force?: boolean }): Promise<void>
	// Only `putAvatarFile` needs it, and it cannot be done without: replacing a state has to
	// publish new bytes without a moment where the state is missing, and `writeFile` is
	// atomic on CREATE only — an overwrite is deliberately not (see `Volume.writeFile`).
	rename(oldPath: string, newPath: string): Promise<void>
}

export interface AgentDeps {
	volume: IdentityVolume
	paths: IdentityPaths
	// The art the app ships, as `{ <id>: { resting: dataUrl, states } }` — injected for the
	// same reason the paths are (it lives in `@justfiles/agent/avatars`, which cannot be
	// imported back). These are the `builtin/<id>` refs: they cost the user no storage,
	// replicate nowhere, and update when the app does. Absent means this host offers none.
	builtins?: Record<string, { resting: string; states: string[] }>
	// The user's timezone (IANA), for the one thing here that depends on today's date:
	// their age. A host whose clock IS the user's clock (the Mac) omits it; one running
	// somewhere else entirely (the frieren DO, on UTC) must not — see `age`.
	timezone?: () => string | Promise<string>
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

// ── avatars ───────────────────────────────────────────────────────────────
// An avatar is a DIRECTORY under `paths.avatars`, named by its id, holding one file per
// state it can be in. Stem = state, extension = format — and the format is never read out of
// the name: `imageType` answers that from the bytes, and `readImageFile` answers which file
// holds a state, identically here and in every other reader of the same directory.

async function entries(vol: IdentityVolume, path: string): Promise<string[]> {
	if (!(await vol.exists(path))) return []
	return (await vol.readdir(path)).map((entry) => entry.name).sort()
}

// The id is the label until there is a store that needs a manifest to carry one.
function label(id: string): string {
	return id.charAt(0).toUpperCase() + id.slice(1)
}

// A birth date is a CALENDAR DATE, not an instant — and so is "today", which is the part
// that bites. `new Date('YYYY-MM-DD')` is UTC midnight, so local getters read the day
// before anywhere west of UTC; and the host's own "now" is no better, because the frieren
// host is a worker running on UTC while the user is wherever they are. Both sides are
// therefore plain `YYYY-MM-DD` in the USER'S calendar, compared as text.
function today(timezone?: string): string {
	// 'en-CA' formats as YYYY-MM-DD, which is what makes the comparison below a string one.
	return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
}

function age(birthDate: string, now: string): number | undefined {
	if (birthDate.length < 10) return undefined
	const years = Number(now.slice(0, 4)) - Number(birthDate.slice(0, 4))
	if (Number.isNaN(years)) return undefined
	// Their birthday this year has not come round yet: MM-DD against MM-DD, no zone in it.
	return now.slice(5) < birthDate.slice(5) ? years - 1 : years
}

function agentMethods({ volume: vol, paths, builtins, timezone, generateSoul }: AgentDeps): Served {
	// Every identity write is READ-MODIFY-WRITE (a profile patch merges with the file, a
	// soul write preserves the avatar being worn) and the panes fire them per field as the
	// user edits — so they queue. Without this, two writes read the same file and the slower
	// one puts back what the other had just changed.
	let queue: Promise<unknown> = Promise.resolve()
	const serial = <T>(run: () => Promise<T>): Promise<T> => {
		const next = queue.then(run, run)
		queue = next.catch(() => {})
		return next
	}
	const readSoul = async (): Promise<AgentSoul> => {
		const { frontmatter, body } = await read(vol, paths.soul)
		return {
			name: frontmatter.agent_name ?? '',
			gender: gender(frontmatter.agent_gender),
			avatar: frontmatter.avatar ?? null,
			body,
			seeded: frontmatter.seeded === 'true'
		}
	}
	const readProfile = async (): Promise<UserFacts> => {
		const { frontmatter } = await read(vol, paths.profile)
		return {
			name: frontmatter.name ?? '',
			birthDate: frontmatter.birth_date ?? '',
			gender: gender(frontmatter.gender)
		}
	}
	return {
		'agent.readSoul': readSoul,
		'agent.writeSoul': (patch) =>
			serial(async () => {
				const current = await readSoul()
				await writeTo(
					vol,
					paths.soul,
					serialize(
						[
							['schema', 'frieren/agent-soul/v1'],
							['agent_name', patch.name ?? current.name],
							['agent_gender', patch.gender ?? current.gender],
							// The avatar is an ordinary patch field, so a plain write preserves the one
							// being worn — a rename must not undress them.
							['avatar', patch.avatar ?? current.avatar]
						],
						patch.body ?? current.body
					)
				)
			}),
		'agent.listAvatars': async () => {
			const art = Object.entries(builtins ?? {}).map(([id, { resting, states }]) => ({
				ref: `builtin/${id}`,
				label: label(id),
				builtin: true,
				preview: resting,
				// A state IS the file name here (see `putAvatarFile`); the volume's own avatars
				// may still carry a pack's `resting.webp`, which the caller stems either way.
				files: states
			}))
			const installed: AvatarInfo[] = []
			for (const id of await entries(vol, paths.avatars)) {
				if (id.startsWith('.')) continue
				const dir = `${paths.avatars}/${id}`
				const files = (await entries(vol, dir)).filter(
					// `.gen` is the image model's lane, not a state anyone authored.
					(name) => !name.startsWith('.')
				)
				// No resting state — or none whose bytes are an image this build can render — is not
				// an avatar yet, and offering it would put a broken portrait in the picker.
				const resting = await readImageFile(files, 'resting', (name) =>
					vol.readFile(`${dir}/${name}`)
				)
				if (!resting) continue
				const preview = imageDataUrl(resting.bytes)
				if (preview) installed.push({ ref: id, label: label(id), builtin: false, preview, files })
			}
			return [...art, ...installed]
		},
		'agent.putAvatarFile': ({ avatar, name, bytes }) =>
			serial(async () => {
				// An id is ONE directory name and a file is ONE name in it: no separator, and no
				// leading dot (`.gen` holds derived art, and `.put-*` below is ours).
				for (const part of [avatar, name]) {
					if (!part || part.startsWith('.') || /[/\\]/.test(part)) {
						throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'settings', 'agent.putAvatarFile')
					}
				}
				const dir = `${paths.avatars}/${avatar}`
				// A WRITE CLAIMS A STATE, NOT A FILENAME: after this, exactly one file holds the
				// state `name` names — or none, for a delete. Replacing a pack's `pleased.webp` with
				// a `pleased.png` must not leave two files claiming `pleased`, because then which one
				// a reader saw would come down to directory order. The uniqueness a state needs is
				// not the one a filesystem gives (it keeps `pleased.png` unique, not `pleased`), so
				// it is enforced here, where the writes are.
				//
				// A STATE IS PUBLISHED AT ONE PATH — `pleased`, never `pleased.webp` — because the
				// extension is the one part of the name that is a LOCAL choice: this browser encodes
				// WebP, Safari falls back to PNG, and sync is last-writer-wins PER PATH. Two devices
				// replacing the same state offline would otherwise land two files sync has no reason
				// to reconcile, and every device would then resolve one of them and silently ignore
				// the other user's replacement — forever. One state, one path, and LWW has something
				// to converge on. Nothing is lost by dropping it: a file's format is read from its
				// bytes (`imageType`), never from its name, and readers stem-match, so a pack's
				// `pleased.webp` still resolves.
				const state = fileStem(name)
				// Order matters, and it is the one `Volume.writeFile` prescribes — with the sweep
				// LAST, so the state the user is wearing outlives every step that can fail:
				//
				//   .put-<state>  a CREATE, therefore atomic, and invisible (dotted names are not
				//                 states). Per state, so two hosts publishing different states at
				//                 once cannot stage over each other.
				//   mv            .put-<state> → <state>  (POSIX rename: replaces atomically)
				//   rm            any OTHER file still claiming this state (a pack's `.webp`)
				//
				// A full volume, a storage error, a vanished staged entry: whatever fails, the old
				// portrait is still there to resolve, because nothing is removed until the new bytes
				// already ARE the state. A reader is never caught between the two either — old state
				// or the whole new one, never a torn image and never a missing face — and in the
				// window between the move and the sweep the extensionless name sorts FIRST among the
				// claimants, so what a reader sees there is the art that just landed. The straight
				// overwrite this replaces could promise neither: it is not atomic by design, and a
				// same-name write is not a structural change, which is all a watcher hears.
				//
				// Nothing needs undoing on failure. The staged bytes are the only thing left behind,
				// under a name no reader resolves, and the next attempt to publish this state writes
				// straight over them.
				const claimants = imageFileNames(await entries(vol, dir), state)
				if (bytes) {
					const staged = `${dir}/.put-${state}`
					await writeTo(vol, staged, bytes)
					await vol.rename(staged, `${dir}/${state}`)
					for (const claimant of claimants) {
						if (claimant !== state) await vol.rm(`${dir}/${claimant}`, { force: true })
					}
				} else {
					for (const claimant of claimants) await vol.rm(`${dir}/${claimant}`, { force: true })
				}
			}),
		'agent.readProfile': readProfile,
		// A PATCH: only the fields passed change. The pane saves per field as you edit, so a
		// whole-profile write would let a slower save put back the name or the date you had
		// already moved on from.
		'agent.writeProfile': (patch) =>
			serial(async () => {
				const current = await readProfile()
				await writeTo(
					vol,
					paths.profile,
					serialize([
						['schema', 'frieren/user-profile/v1'],
						['name', patch.name ?? current.name],
						['birth_date', patch.birthDate ?? current.birthDate],
						['gender', patch.gender === undefined ? current.gender : patch.gender]
					])
				)
			}),
		...(generateSoul && {
			// A PREVIEW. The user facts ride along from the volume, so the pane sends only
			// what it actually collected.
			'agent.generateSoul': async ({ name, gender: sex, archetype, user }) => {
				// The caller's facts win when it sent them: it read them from the volume the
				// user is actually typing into, which is not necessarily this one.
				const facts = user ?? (await readProfile())
				return generateSoul({
					name,
					gender: sex,
					archetype,
					userAge: age(facts.birthDate ?? '', today(await timezone?.())),
					userGender: facts.gender ?? undefined
				})
			}
		})
	}
}

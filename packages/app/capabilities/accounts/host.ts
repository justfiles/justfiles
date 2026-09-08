// Host-side machinery for the `accounts` model — never shipped to apps, and generic over
// the provider registry: this file names no provider. Each platform constructs the
// Provider[] it offers (see providers/) and passes it to `hostAccounts`, which builds ONE
// account module for that host instance: the use facets, the admin surface, and the
// host-only AI lease, all over one credential-bearing store that never crosses the package
// boundary. One module, because independent stores over the same files is how a
// read/modify/write loses an update.
//
// Nothing here writes a file to become usable. The built-in platform account and the
// active-AI selection are DERIVED: a `builtin` provider that backs `ai` IS the platform
// floor, and an absent (or dangling) selection means exactly that floor. So an empty
// `/private` — a fresh sign-up, and the volume a destructive reset leaves behind — already
// resolves AI, with no seeding step for a republish to race.

import type { Volume } from '@justfiles/fs'
import { calendar } from '../calendar/index.ts'
import { email } from '../email/index.ts'
import { CapabilityError } from '../error.ts'
import { image } from '../image/index.ts'
import { implementCapability } from '../implement.ts'
import type { Capability } from '../types.ts'
import { type Account, type AccountStore, type SecretCodec, volumeAccountStore } from './account.ts'
import { volumeActiveAi } from './active-ai.ts'
import { connections } from './connect.ts'
import type {
	AccountInfo,
	AccountOrigin,
	AccountsAdmin,
	CapabilityId,
	ProviderInfo
} from './contract.ts'
import type {
	AcquiredAccount,
	Binding,
	BoundAccount,
	CredentialAccess,
	Provider
} from './provider.ts'

export type { SecretCodec } from './account.ts'
// The at-rest seal for the creds lane, re-exported for hosts: each supplies its own root
// secret (frieren `ENCRYPTION_KEY`, mac the Keychain) and passes the codec to `hostAccounts`.
export { aesGcmSecretCodec } from './secret-codec.ts'

export interface AccountsOptions {
	// Seals the `creds` lane at rest with this host's own key (see secret-codec.ts).
	// Absent = clear.
	secretCodec?: SecretCodec
	// Who this host is, stamped onto every AccountInfo it projects (D1/D2, #290/#296).
	// The DO passes `{ kind: 'cloud' }`; the mac daemon passes `{ kind: 'device', label:
	// <hostname> }`. Omitted → `AccountInfo.origin` stays undefined.
	origin?: AccountOrigin
	// How this host keeps best-effort background work alive past the call that started it.
	// The one such piece of work is the reseal sweep, which no caller awaits — on a Worker
	// that means the runtime may end the event (or hibernate the Durable Object) before it
	// finishes, and the plaintext it exists to close would survive, since nothing else ever
	// rewrites those records. The DO passes `ctx.waitUntil`; a long-lived process (the mac
	// daemon) has an event loop that outlives every request and needs nothing here.
	waitUntil?: (work: Promise<unknown>) => void
}

// A short-lived borrow of the active-AI account, for building the agent's own LLM
// runtime — the one consumer that legitimately needs the creds (to *construct* a
// runtime), so it gets a lease, not the store. `creds` stay inside the caller's `mint`
// closure; `persist` is the only writeback (rotated tokens on refresh). The generic `T`
// keeps @justfiles/app free of any agent/pi-ai dependency; `providerId` lets the caller
// branch on which ai provider is active.
export interface AiSelection {
	accountId: string
	model?: string
	revision: string
}

export interface AiAccountLease extends BoundAccount {
	accountId: string
	revision: string
	config: unknown
	providerId: string
}

// One host instance's accounts, in one object. Callers get facets and answers — never the
// store, the credentials, a readiness step, or anything about how writes are ordered.
export interface HostAccounts {
	readonly image: Capability
	readonly email: Capability
	readonly calendar: Capability
	// Not a capability: the admin impl `settingsHost` exposes as `accounts.*`.
	readonly admin: AccountsAdmin
	// The text `ai` capability is host-owned (each host builds it over its own model), so it
	// resolves the active account through here rather than through a capability.
	resolveAi<T>(
		mint: (lease: AiAccountLease) => T | Promise<T>,
		selection?: AiSelection
	): Promise<T | null>
}

type Registry = Map<string, Provider>

// Who is answering as the AI right now, and with which model — the single answer every
// call path reads (see `active` below).
type ActiveAi = { account: Account; model?: string }

// ── The derived platform floor ────────────────────────────────────────────

// The platform's builtin AI account. It carries no credentials, so it is always usable and
// never "off" — a user's own AI account takes over while it is selected, and clearing that
// selection lands back here rather than leaving the user with no AI at all.
//
// Derived, never stored: a `builtin` provider that backs `ai` is the platform's own, and
// one platform account per provider means the provider id IS the account id. Absence of a
// file is therefore the built-in account, not a missing one — which is what lets a host
// boot, and a wiped volume resolve AI, without writing anything first. A host with no
// builtin AI provider (the Mac) has no floor at all.
function floorAccount(registry: Registry, capability: 'ai' | 'image' = 'ai'): Account | undefined {
	for (const provider of registry.values())
		if (provider.builtin && provider.capabilities[capability])
			return { id: provider.id, provider: provider.id, creds: {} }
	return undefined
}

// Persisted accounts, with the floor derived rather than read. A leftover record for it
// (written by the seeding this replaced) says nothing the floor does not, and under a
// rotated key it reads back broken — which must never be what the platform AI looks like.
function withFloor(stored: Account[], floor: Account | undefined): Account[] {
	if (!floor) return stored
	const at = stored.findIndex((a) => a.id === floor.id)
	return at === -1 ? [...stored, floor] : stored.with(at, floor)
}

// ── Binding resolution ────────────────────────────────────────────────────

// Bind an account through one of its provider's capability bindings, or undefined
// when the provider isn't offered here or the required scope wasn't granted.
// `persist` writes rotated creds back to the same account record.
function bound<T>(
	accounts: AccountStore,
	account: Account,
	binding: Binding<T> | undefined,
	config?: unknown
): T | undefined {
	if (!binding) return undefined
	// Unreadable creds (key rotated/foreign) — the account is listed but unusable, so
	// the capability reports UNAVAILABLE instead of handing a provider an envelope.
	if (account.creds === undefined) return undefined
	if (binding.scope !== undefined && !(account.scopes?.includes(binding.scope) ?? false))
		return undefined
	return binding.bind({
		creds: account.creds,
		credentials: credentialAccess(accounts, account),
		config,
		persist: writebackFor(accounts, account)
	})
}

// The one writeback: rotated creds go back to the account record (a provider whose tokens
// refresh mid-use MUST call it, or a later mint reuses a consumed grant). A call is bound over
// a SNAPSHOT and a token exchange can land long after it was taken, so the write is a
// compare-and-set on the creds lane — it only ever replaces the value this client last saw
// there, and it decides inside the store's per-account chain, so what it compares against is
// what it then replaces. Two lost updates fall out of that:
//   - the account was disconnected mid-flight — writing would resurrect the record, credential
//     and all, after a disconnect that already reported success;
//   - the account was re-connected, or widened by incremental consent — `setEnabled` writes a
//     whole new grant, and overwriting it with an older refresh result is the lost update that
//     leaves the user re-connecting.
// `expected` advances only on a write that actually landed, so a provider that rotates
// repeatedly (pi-ai's Codex credential store does) still lands every rotation, and a write
// that failed to seal leaves the next attempt comparing against what is really on disk.
function writebackFor(accounts: AccountStore, account: Account): (creds: unknown) => Promise<void> {
	let expected = account.creds
	return async (creds) => {
		let replaced = false
		await accounts.update(account.id, (current) => {
			if (!current || !sameCreds(current.creds, expected)) return undefined
			replaced = true
			return { ...current, creds }
		})
		if (replaced) expected = creds
	}
}

// Creds are plain JSON (a provider's own token record), so structural equality is text equality.
const sameCreds = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// Accounts backing `capability` (optionally one), each turned into a live client.
async function resolveClients<C>(
	list: () => Promise<Account[]>,
	client: (account: Account) => C | undefined,
	accountId?: string
): Promise<{ accountId: string; impl: C }[]> {
	const out: { accountId: string; impl: C }[] = []
	for (const account of await list()) {
		if (accountId !== undefined && account.id !== accountId) continue
		const impl = client(account)
		if (impl) out.push({ accountId: account.id, impl })
	}
	return out
}

// Fan a list call across every backing account (or one), stamp each result with its
// source, and concatenate. No backing account ⇒ UNAVAILABLE (the "not configured"
// signal, distinct from a configured-but-empty inbox).
async function fanOut<C, R extends { accountId?: string }>(
	list: () => Promise<Account[]>,
	capability: CapabilityId,
	client: (account: Account) => C | undefined,
	accountId: string | undefined,
	call: (impl: C) => Promise<R[]>
): Promise<R[]> {
	const targets = await resolveClients(list, client, accountId)
	if (targets.length === 0) throw new CapabilityError('CAPABILITY_UNAVAILABLE', capability)
	const lists = await Promise.all(
		targets.map(async (t) => (await call(t.impl)).map((r) => ({ ...r, accountId: t.accountId })))
	)
	return lists.flat()
}

// Single-account resolution (readDetail/markRead target the summary's accountId).
async function resolveOne<C>(
	list: () => Promise<Account[]>,
	capability: CapabilityId,
	client: (account: Account) => C | undefined,
	accountId?: string
): Promise<C> {
	const [first] = await resolveClients(list, client, accountId)
	if (!first) throw new CapabilityError('CAPABILITY_UNAVAILABLE', capability)
	return first.impl
}

// ── Admin projection ──────────────────────────────────────────────────────

// The per-capability config the UI renders: only `ai` is meaningful, and only when
// its provider carries a model catalogue (the Settings model picker).
function aiConfig(provider: Provider | undefined, model: string | undefined): unknown {
	const binding = provider?.capabilities.ai
	if (!binding?.models) return {}
	return { model: model ?? binding.defaultModel?.() ?? '', models: binding.models() }
}

// Assemble one account's projection: enablement is DERIVED (email/calendar from
// the provider's bindings + granted scopes, ai from the resolved active AI).
function toAccountInfo(
	account: Account,
	active: ActiveAi | undefined,
	registry: Registry,
	origin: AccountOrigin | undefined,
	imageAccountId?: string
): AccountInfo {
	const provider = registry.get(account.provider)
	const enabled: CapabilityId[] = []
	for (const capability of ['email', 'calendar'] as const) {
		const binding = provider?.capabilities[capability]
		if (!binding) continue
		if (binding.scope === undefined || (account.scopes?.includes(binding.scope) ?? false))
			enabled.push(capability)
	}
	const isActiveAi = active?.account.id === account.id
	if (isActiveAi) enabled.push('ai')
	if (account.id === imageAccountId) enabled.push('image')
	const config: Partial<Record<CapabilityId, unknown>> = {}
	if (isActiveAi) config.ai = aiConfig(provider, active?.model)
	const info: AccountInfo = { accountId: account.id, providerId: account.provider, enabled, config }
	if (account.lastError) info.lastError = account.lastError
	if (origin) info.origin = origin
	return info
}

// ── The module ────────────────────────────────────────────────────────────

// One factory over the platform's provider registry, memoised by each host for its own
// instance (the frieren Durable Object; the mac daemon process). Construction touches no
// storage and writes nothing.
export function hostAccounts(
	providers: Provider[],
	volume: Volume,
	opts: AccountsOptions = {}
): HostAccounts {
	const registry: Registry = new Map(providers.map((p) => [p.id, p]))
	const store = volumeAccountStore(volume, opts)
	const activeAi = volumeActiveAi(volume)
	const floor = floorAccount(registry)
	const imageFloor = floorAccount(registry, 'image')
	const origin = opts.origin
	const save = async (providerId: string, acquired: AcquiredAccount, signal?: AbortSignal) => {
		await store.update(acquired.accountId, (prev) => {
			signal?.throwIfAborted()
			const scopes = [...new Set([...(prev?.scopes ?? []), ...(acquired.scopes ?? [])])]
			return {
				id: acquired.accountId,
				provider: providerId,
				creds: acquired.creds,
				revision: crypto.randomUUID(),
				...(scopes.length > 0 ? { scopes } : {})
			}
		})
	}
	const connect = connections({ providers: registry, save, waitUntil: opts.waitUntil })

	// Seal every account record still sitting in the clear, with this host's key.
	//
	// Needed because `decode` deliberately passes a non-envelope through (that is what makes
	// turning encryption on a no-flag-day change) — so nothing else would ever rewrite a
	// credential that does not rotate. No provider persists rotated creds today, and an iCloud
	// app-specific password is written exactly once, at connect: "it gets sealed on the next
	// write" means "never" for those, leaving plaintext in every dump and backup taken after we
	// believed the lane was encrypted. Same story for records a host wrote while its key was
	// missing.
	//
	// Best effort and NEVER awaited: whether a credential got sealed cannot decide whether an
	// account resolves, so no caller waits on this and no caller can see it. Kicked once when
	// the module comes up (the plaintext this closes belongs to records nothing else rewrites,
	// so waiting for a read would be waiting forever) and again on any later account entry if
	// that attempt failed — a Keychain that was locked may be open by then.
	//
	// Not awaited is not the same as not retained: `opts.waitUntil` is what holds the sweep
	// open past the call that kicked it on a host whose events end (see AccountsOptions). It
	// is handed the SETTLED chain, so a failed sweep stays a warning rather than surfacing as
	// an unhandled rejection in the host's event.
	let sealing: Promise<void> | undefined
	const seal = (): void => {
		if (!opts.secretCodec || sealing) return
		const attempt = store.reseal()
		sealing = attempt
		// Attached unconditionally — `?.()` would not evaluate its argument without a
		// `waitUntil`, leaving a host that needs none with an unhandled rejection.
		const settled = attempt.catch((e) => {
			console.warn('accounts: could not seal credentials at rest', e)
			if (sealing === attempt) sealing = undefined
		})
		opts.waitUntil?.(settled)
	}
	seal()

	// Every read of the account set goes through here, so the floor is derived once and the
	// reseal sweep has exactly one trigger.
	const list = async (): Promise<Account[]> => {
		seal()
		return withFloor(withFloor(await store.list(), floor), imageFloor)
	}
	const get = async (id: string): Promise<Account | undefined> =>
		floor?.id === id ? floor : imageFloor?.id === id ? imageFloor : store.get(id)

	// A connected selection stays selected when its credential fails. Only removing
	// the account returns inference to the built-in provider.
	const active = async (): Promise<ActiveAi | undefined> => {
		seal()
		const selected = await activeAi.get()
		if (selected) {
			const account = await get(selected.accountId)
			if (account) return { account, model: selected.model }
		}
		return floor && { account: floor }
	}

	const emailClient = (a: Account) => bound(store, a, registry.get(a.provider)?.capabilities.email)
	const calendarClient = (a: Account) =>
		bound(store, a, registry.get(a.provider)?.capabilities.calendar)

	const invalid = (method: string) =>
		new CapabilityError('CAPABILITY_INVALID_INPUT', 'accounts', method)

	return {
		// Images keep their built-in provider when the user selects another text account.
		image: implementCapability(image, {
			generateImage: async (_c, i) => {
				const impl =
					imageFloor &&
					bound(store, imageFloor, registry.get(imageFloor.provider)?.capabilities.image)
				if (!impl) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'image')
				return impl.generateImage(i)
			}
		}),

		email: implementCapability(email, {
			listUnread: (_c, i) =>
				fanOut(list, 'email', emailClient, i.accountId, (impl) => impl.listUnread(i)),
			readDetail: async (_c, i) =>
				(await resolveOne(list, 'email', emailClient, i.accountId)).readDetail(i),
			markRead: async (_c, i) =>
				(await resolveOne(list, 'email', emailClient, i.accountId)).markRead(i)
		}),

		calendar: implementCapability(calendar, {
			listToday: (_c, i) =>
				fanOut(list, 'calendar', calendarClient, i.accountId, (impl) => impl.listToday(i))
		}),

		// Every admin method is privileged, but the identity gate is NOT here: the admin
		// surface reaches apps only through the `settings` capability, which gates on
		// first-party app identity once, for every method (see settings/host.ts).
		admin: {
			...connect,
			listProviders: async () => {
				return providers.map((p) => {
					const ui = p.auth.ui
					const info: ProviderInfo = {
						id: p.id,
						name: p.name,
						authKind: ui.kind,
						capabilities: (['email', 'calendar', 'ai', 'image'] as const).filter(
							(k) => p.capabilities[k] !== undefined
						)
					}
					if (p.builtin) info.builtin = true
					if (ui.kind === 'form') info.credentialsSchema = ui.schema
					return info
				})
			},
			listAccounts: async () => {
				const [all, current] = await Promise.all([list(), active()])
				return all.map((account) =>
					toAccountInfo(account, current, registry, origin, imageFloor?.id)
				)
			},
			connect: async ({ providerId, credentials }) => {
				const provider = registry.get(providerId)
				if (!provider) throw invalid('connect')
				if (provider.auth.ui.kind === 'form' && !credentials) throw invalid('connect')
				// Connect requests no capability scopes yet — just the identity the provider
				// needs to derive accountId. Acquisition is external I/O, so it runs OUTSIDE the
				// account's chain; only the merge that preserves prior grants (so a re-connect,
				// e.g. a token refresh, keeps enabled services on) is serialized.
				const { accountId, creds, scopes } = await provider.auth.acquire({
					fields: credentials,
					scopes: []
				})
				await save(providerId, { accountId, creds, scopes })
				return { accountId }
			},
			setEnabled: async ({ accountId, capability, enabled, config }) => {
				const account = await get(accountId)
				if (!account) throw invalid('setEnabled')
				if (capability === 'image') {
					if (account.id !== imageFloor?.id) throw invalid('setEnabled')
					return
				}
				// ai is single-active: the selection pointer, not a scope.
				if (capability === 'ai') {
					if (enabled) {
						const model = (config as { model?: string } | undefined)?.model
						const prev = await activeAi.get()
						const chosen = model ?? (prev?.accountId === accountId ? prev.model : undefined)
						await activeAi.set(chosen !== undefined ? { accountId, model: chosen } : { accountId })
					} else if ((await activeAi.get())?.accountId === accountId) {
						// Turning the active AI off drops the explicit selection, and an absent selection
						// IS the platform floor — so there is always a backend. Turning the FLOOR off
						// therefore re-selects it: the floor has no off state, it is only taken over
						// (Settings renders that toggle uncheckable). A floor that is merely derived has
						// no pointer to drop, so this is already a no-op there.
						await activeAi.set(null)
					}
					return
				}
				// email/calendar enablement lives in the account's granted scopes.
				const provider = registry.get(account.provider)
				const scope = provider?.capabilities[capability]?.scope
				// No scope to toggle (form providers) — the capability is granted by the
				// account existing; to stop it, disconnect the account.
				if (!provider || scope === undefined) return
				if (enabled) {
					if (account.scopes?.includes(scope) ?? false) return
					// Incremental consent: re-run acquisition for the widened scope set. The user is in
					// a browser for this, so it stays outside the chain; the write that follows takes
					// the account as it is by then, and declines if it was disconnected meanwhile.
					const widened = [...new Set([...(account.scopes ?? []), scope])]
					const res = await provider.auth.acquire({ scopes: widened })
					await store.update(accountId, (current) =>
						current
							? {
									id: current.id,
									provider: current.provider,
									creds: res.creds,
									scopes: res.scopes ?? widened
								}
							: undefined
					)
					return
				}
				await store.update(accountId, (current) => {
					if (!current) return undefined
					const have = new Set(current.scopes ?? [])
					if (!have.delete(scope)) return undefined
					// `current.creds`, not the snapshot's: a refresh may have landed since, and
					// dropping a scope must not roll the credential back with it.
					const next: Account = { id: current.id, provider: current.provider, creds: current.creds }
					if (have.size > 0) next.scopes = [...have]
					return next
				})
			},
			disconnect: async ({ accountId }) => {
				await store.delete(accountId)
				// Deleted first, so dropping the pointer can never race a resurrect. An absent
				// selection lands on the platform floor.
				if ((await activeAi.get())?.accountId === accountId) await activeAi.set(null)
			}
		},

		async resolveAi<T>(
			mint: (lease: AiAccountLease) => T | Promise<T>,
			selection?: AiSelection
		): Promise<T | null> {
			const current = selection
				? { account: await get(selection.accountId), model: selection.model }
				: await active()
			if (
				selection &&
				(!current?.account || (current.account.revision ?? '') !== selection.revision)
			)
				throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'ai')
			// Only on a host with no builtin AI and nothing usable selected: the caller surfaces
			// "turn on AI in Settings", and a broken record's own lastError says why.
			if (!current?.account) return null
			const account = current.account
			if (!registry.get(account.provider)?.capabilities.ai) throw invalid('resolveAi')

			return mint({
				accountId: account.id,
				revision: account.revision ?? '',
				credentials: credentialAccess(store, account),
				creds: current.account.creds,
				config: current.model !== undefined ? { model: current.model } : {},
				providerId: current.account.provider,
				persist: writebackFor(store, current.account)
			})
		}
	}
}

function credentialAccess(store: AccountStore, account: Account): CredentialAccess {
	const check = (value: Account | undefined): Account => {
		if (!value || value.creds === undefined || value.revision !== account.revision)
			throw new Error('Account changed or disconnected. Reconnect in Settings.')
		return value
	}
	return {
		read: async () => check(await store.get(account.id)).creds,
		modify: async (change) => {
			let result: unknown
			await store.update(account.id, async (stored) => {
				const latest = check(stored)
				const next = await change(latest.creds)
				result = next ?? latest.creds
				return next === undefined ? undefined : { ...latest, creds: next }
			})
			return result
		}
	}
}

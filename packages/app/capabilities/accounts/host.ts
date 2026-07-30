// Host-side machinery for the `accounts` model — never shipped to apps, and generic
// over the provider registry: this file names no provider. Each platform constructs
// the Provider[] it offers (see providers/) and passes it here; everything else is
// derived — which capability an account backs comes from its provider's bindings +
// the account's granted scopes, and the single active AI is a separate pointer.
// The credential-bearing stores are built once internally from the Volume and never
// cross the package boundary.

import type { Volume } from '@justfiles/fs'
import { calendar } from '../calendar/index.ts'
import { email } from '../email/index.ts'
import { CapabilityError } from '../error.ts'
import { image } from '../image/index.ts'
import { implementCapability } from '../implement.ts'
import type { Capability } from '../types.ts'
import { type Account, type AccountStore, type SecretCodec, volumeAccountStore } from './account.ts'
import { type ActiveAiStore, volumeActiveAi } from './active-ai.ts'
import type {
	AccountInfo,
	AccountOrigin,
	AccountsAdmin,
	CapabilityId,
	ProviderInfo
} from './contract.ts'
import type { Binding, Provider } from './provider.ts'

export type { SecretCodec } from './account.ts'
// The at-rest seal for the creds lane, re-exported for hosts: each supplies its own root
// secret (frieren `ENCRYPTION_KEY`, mac the Keychain) and passes the codec to the entry
// points below.
export { aesGcmSecretCodec } from './secret-codec.ts'

export interface AccountsOptions {
	// Seals the `creds` lane at rest with this host's own key (see secret-codec.ts).
	// Absent = clear. EVERY entry point below takes it: they all build the same store,
	// and a codec on some but not all of them means half the reads can't decrypt.
	secretCodec?: SecretCodec
	// Who this host is, stamped onto every AccountInfo it projects (D1/D2, #290/#296).
	// The DO passes `{ kind: 'cloud' }`; the mac daemon passes `{ kind: 'device', label:
	// <hostname> }`. Omitted → `AccountInfo.origin` stays undefined.
	origin?: AccountOrigin
}

type Registry = Map<string, Provider>

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
		config,
		persist: writebackFor(accounts, account)
	})
}

// The one writeback: rotated creds go back to the account record (a provider whose tokens
// refresh mid-use MUST call it, or a later mint reuses a consumed grant). A call is bound over
// a SNAPSHOT and a token exchange can land long after it was taken, so the write is a
// compare-and-set on the creds lane — it only ever replaces the value this client last saw
// there. Two lost updates fall out of that:
//   - the account was disconnected mid-flight — writing would resurrect the record, credential
//     and all, after a disconnect that already reported success;
//   - the account was re-connected, or widened by incremental consent — `setEnabled` writes a
//     whole new grant, and overwriting it with an older refresh result is the lost update that
//     leaves the user re-connecting.
// `expected` advances on every write, so a provider that rotates repeatedly (pi-ai's Codex
// credential store does) still lands every rotation.
// Not atomic — the store has no compare-and-set — but it never replaces a value it did not read.
function writebackFor(accounts: AccountStore, account: Account): (creds: unknown) => Promise<void> {
	let expected = account.creds
	return async (creds) => {
		const current = await accounts.get(account.id)
		if (!current || !sameCreds(current.creds, expected)) return
		await accounts.put({ ...current, creds })
		expected = creds
	}
}

// Creds are plain JSON (a provider's own token record), so structural equality is text equality.
const sameCreds = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// Accounts backing `capability` (optionally one), each turned into a live client.
async function resolveClients<C>(
	accounts: AccountStore,
	client: (account: Account) => C | undefined,
	accountId?: string
): Promise<{ accountId: string; impl: C }[]> {
	const out: { accountId: string; impl: C }[] = []
	for (const account of await accounts.list()) {
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
	accounts: AccountStore,
	capability: CapabilityId,
	client: (account: Account) => C | undefined,
	accountId: string | undefined,
	call: (impl: C) => Promise<R[]>
): Promise<R[]> {
	const targets = await resolveClients(accounts, client, accountId)
	if (targets.length === 0) throw new CapabilityError('CAPABILITY_UNAVAILABLE', capability)
	const lists = await Promise.all(
		targets.map(async (t) => (await call(t.impl)).map((r) => ({ ...r, accountId: t.accountId })))
	)
	return lists.flat()
}

// Single-account resolution (readDetail/markRead target the summary's accountId).
async function resolveOne<C>(
	accounts: AccountStore,
	capability: CapabilityId,
	client: (account: Account) => C | undefined,
	accountId?: string
): Promise<C> {
	const [first] = await resolveClients(accounts, client, accountId)
	if (!first) throw new CapabilityError('CAPABILITY_UNAVAILABLE', capability)
	return first.impl
}

// ── Use-facet hosts ───────────────────────────────────────────────────────

function emailHost(accounts: AccountStore, registry: Registry): Capability {
	const client = (a: Account) => bound(accounts, a, registry.get(a.provider)?.capabilities.email)
	return implementCapability(email, {
		listUnread: (_c, i) =>
			fanOut(accounts, 'email', client, i.accountId, (impl) => impl.listUnread(i)),
		readDetail: async (_c, i) =>
			(await resolveOne(accounts, 'email', client, i.accountId)).readDetail(i),
		markRead: async (_c, i) =>
			(await resolveOne(accounts, 'email', client, i.accountId)).markRead(i)
	})
}

function calendarHost(accounts: AccountStore, registry: Registry): Capability {
	const client = (a: Account) => bound(accounts, a, registry.get(a.provider)?.capabilities.calendar)
	return implementCapability(calendar, {
		listToday: (_c, i) =>
			fanOut(accounts, 'calendar', client, i.accountId, (impl) => impl.listToday(i))
	})
}

// `image` rides the same active-AI selection — switching the AI account swaps text
// and image together. The account's provider backs it or it's unavailable; the model
// choice lives with the binding (no image entry on the pointer yet).
function imageHost(
	accounts: AccountStore,
	activeAi: ActiveAiStore,
	registry: Registry
): Capability {
	return implementCapability(image, {
		generateImage: async (_c, i) => {
			const sel = await activeAi.get()
			const account = sel ? await accounts.get(sel.accountId) : undefined
			const impl = account
				? bound(accounts, account, registry.get(account.provider)?.capabilities.image)
				: undefined
			if (!impl) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'image')
			return impl.generateImage(i)
		}
	})
}

// ── Admin surface ───────────────────────────────────────────────────────

// The floor under the single-active AI: the platform's builtin AI account. It carries no
// credentials, so it is always usable and never "off" — a user's own AI account takes over
// while it is selected, and clearing that selection lands back here rather than leaving the
// user with no AI at all. Derived, not configured: a builtin provider that backs `ai` is
// the platform's own (Settings offers it toggles, never connect/disconnect).
async function floorAi(accounts: AccountStore, registry: Registry): Promise<string | undefined> {
	for (const account of await accounts.list()) {
		const provider = registry.get(account.provider)
		if (provider?.builtin && provider.capabilities.ai) return account.id
	}
	return undefined
}

// Hand the selection back to the floor (or clear it, on a host with no builtin AI).
async function fallBackToFloor(
	accounts: AccountStore,
	activeAi: ActiveAiStore,
	registry: Registry
): Promise<void> {
	const floor = await floorAi(accounts, registry)
	await activeAi.set(floor !== undefined ? { accountId: floor } : null)
}

// The per-capability config the UI renders: only `ai` is meaningful, and only when
// its provider carries a model catalogue (the Settings model picker).
function aiConfig(provider: Provider | undefined, model: string | undefined): unknown {
	const binding = provider?.capabilities.ai
	if (!binding?.models) return {}
	return { model: model ?? binding.defaultModel?.() ?? '', models: binding.models() }
}

// Assemble one account's projection: enablement is DERIVED (email/calendar from
// the provider's bindings + granted scopes, ai from the active selection).
function toAccountInfo(
	account: Account,
	sel: { accountId: string; model?: string } | null,
	registry: Registry,
	origin: AccountOrigin | undefined
): AccountInfo {
	const provider = registry.get(account.provider)
	const enabled: CapabilityId[] = []
	for (const capability of ['email', 'calendar'] as const) {
		const binding = provider?.capabilities[capability]
		if (!binding) continue
		if (binding.scope === undefined || (account.scopes?.includes(binding.scope) ?? false))
			enabled.push(capability)
	}
	const isActiveAi = sel?.accountId === account.id
	if (isActiveAi) enabled.push('ai')
	const config: Partial<Record<CapabilityId, unknown>> = {}
	if (isActiveAi) config.ai = aiConfig(provider, sel?.model)
	const info: AccountInfo = { accountId: account.id, providerId: account.provider, enabled, config }
	if (account.lastError) info.lastError = account.lastError
	if (origin) info.origin = origin
	return info
}

// The admin impl. Every method is privileged, but the identity gate is NOT here: the
// admin surface reaches apps only through the `settings` capability, which gates on
// first-party app identity once, for every method (see settings/host.ts).
function accountsAdminImpl(
	providers: Provider[],
	registry: Registry,
	accounts: AccountStore,
	activeAi: ActiveAiStore,
	origin: AccountOrigin | undefined
): AccountsAdmin {
	const invalid = (method: string) =>
		new CapabilityError('CAPABILITY_INVALID_INPUT', 'accounts', method)

	return {
		listProviders: async () => {
			return providers.map((p) => {
				const ui = p.auth.ui
				const info: ProviderInfo = {
					id: p.id,
					name: p.name,
					authKind: ui.kind,
					capabilities: (['email', 'calendar', 'ai'] as const).filter(
						(k) => p.capabilities[k] !== undefined
					)
				}
				if (p.builtin) info.builtin = true
				if (ui.kind === 'form') info.credentialsSchema = ui.schema
				return info
			})
		},
		listAccounts: async () => {
			const [all, sel] = await Promise.all([accounts.list(), activeAi.get()])
			return all.map((account) => toAccountInfo(account, sel, registry, origin))
		},
		connect: async ({ providerId, credentials }) => {
			const provider = registry.get(providerId)
			if (!provider) throw invalid('connect')
			if (provider.auth.ui.kind === 'form' && !credentials) throw invalid('connect')
			// Connect requests no capability scopes yet — just the identity the provider
			// needs to derive accountId. Preserve any prior grants so a re-connect
			// (e.g. token refresh) keeps enabled services on.
			const { accountId, creds, scopes } = await provider.auth.acquire({
				fields: credentials,
				scopes: []
			})
			const prev = await accounts.get(accountId)
			const merged = [...new Set([...(prev?.scopes ?? []), ...(scopes ?? [])])]
			const account: Account = { id: accountId, provider: providerId, creds }
			if (merged.length > 0) account.scopes = merged
			await accounts.put(account)
			return { accountId }
		},
		setEnabled: async ({ accountId, capability, enabled, config }) => {
			const account = await accounts.get(accountId)
			if (!account) throw invalid('setEnabled')
			// ai is single-active: the selection pointer, not a scope.
			if (capability === 'ai') {
				if (enabled) {
					const model = (config as { model?: string } | undefined)?.model
					const prev = await activeAi.get()
					const chosen = model ?? (prev?.accountId === accountId ? prev.model : undefined)
					await activeAi.set(chosen !== undefined ? { accountId, model: chosen } : { accountId })
				} else if ((await activeAi.get())?.accountId === accountId) {
					// Turning the active AI off hands the selection back to the builtin AI, so there is
					// always a backend. Turning the BUILTIN off therefore re-selects it: the floor has
					// no off state, it is only taken over (Settings renders that toggle uncheckable).
					await fallBackToFloor(accounts, activeAi, registry)
				}
				return
			}
			// email/calendar enablement lives in the account's granted scopes.
			const provider = registry.get(account.provider)
			const scope = provider?.capabilities[capability]?.scope
			// No scope to toggle (form providers) — the capability is granted by the
			// account existing; to stop it, disconnect the account.
			if (!provider || scope === undefined) return
			const have = new Set(account.scopes ?? [])
			if (enabled) {
				if (have.has(scope)) return
				// Incremental consent: re-run acquisition for the widened scope set.
				const widened = [...new Set([...(account.scopes ?? []), scope])]
				const res = await provider.auth.acquire({ scopes: widened })
				await accounts.put({
					id: account.id,
					provider: account.provider,
					creds: res.creds,
					scopes: res.scopes ?? widened
				})
			} else {
				have.delete(scope)
				const next: Account = { id: account.id, provider: account.provider, creds: account.creds }
				if (have.size > 0) next.scopes = [...have]
				await accounts.put(next)
			}
		},
		disconnect: async ({ accountId }) => {
			await accounts.delete(accountId)
			// Deleted first, so the floor lookup can never land back on the account just removed.
			if ((await activeAi.get())?.accountId === accountId)
				await fallBackToFloor(accounts, activeAi, registry)
		}
	}
}

// ── Entry points ──────────────────────────────────────────────────────────

// One factory over the platform's provider registry. The credential-bearing stores
// are built once internally from the Volume and never cross the package boundary.
// NOTE: `ai` is deliberately NOT here — the text `ai` capability (and its
// purpose-scoped context composition) is host-owned; each host builds it over its
// own model, resolving the active account through `resolveAiAccount` below.
export function accountsCapabilities(
	providers: Provider[],
	volume: Volume,
	opts: AccountsOptions = {}
): {
	image: Capability
	email: Capability
	calendar: Capability
	// Not a capability: the admin impl `settingsHost` exposes as `accounts.*`.
	accounts: AccountsAdmin
} {
	const registry: Registry = new Map(providers.map((p) => [p.id, p]))
	const accounts = volumeAccountStore(volume, opts)
	const activeAi = volumeActiveAi(volume)
	return {
		image: imageHost(accounts, activeAi, registry),
		email: emailHost(accounts, registry),
		calendar: calendarHost(accounts, registry),
		accounts: accountsAdminImpl(providers, registry, accounts, activeAi, opts.origin)
	}
}

// Seal every account record still sitting in the clear, with this host's key. Best-effort:
// a host must boot even if it fails.
//
// Needed because `decode` deliberately passes a non-envelope through (that is what makes
// turning encryption on a no-flag-day change) — so nothing else would ever rewrite a
// credential that does not rotate. No provider persists rotated creds today, and an iCloud
// app-specific password is written exactly once, at connect: "it gets sealed on the next
// write" means "never" for those, leaving plaintext in every dump and backup taken after we
// believed the lane was encrypted. Same story for records a host wrote while its key was
// missing. This closes both, on the next boot after the key lands.
//
// A no-op without a key (nothing to seal with) and cheap with one: already-sealed records
// are skipped, so a steady-state boot writes nothing.
export async function sealAccounts(
	volume: Volume,
	opts: { secretCodec?: SecretCodec } = {}
): Promise<void> {
	if (!opts.secretCodec) return
	try {
		await volumeAccountStore(volume, opts).reseal()
	} catch (e) {
		console.warn('accounts: could not seal credentials at rest', e)
	}
}

// Seed a credential-less account for a platform-managed provider (the built-in AI) that
// should be present, and make it the active AI unless a live selection already answers —
// the platform AI is the floor, so a signed-in user always has a working agent. Idempotent:
// a user's own AI account keeps the selection (model and all) while it resolves here.
export async function ensureAccount(
	volume: Volume,
	input: { accountId: string; providerId: string; enabled: CapabilityId[] },
	opts: { secretCodec?: SecretCodec } = {}
): Promise<void> {
	const accounts = volumeAccountStore(volume, opts)
	const existing = await accounts.get(input.accountId)
	// A record whose creds this host cannot read counts as absent: the only account this
	// seeds is the platform one, which is credential-less, so re-seeding it heals a rotated
	// key instead of leaving the agent with no backend. (A user's own account is never
	// seeded here — it lists as broken and is re-connected.)
	if (!existing || existing.creds === undefined)
		await accounts.put({ id: input.accountId, provider: input.providerId, creds: {} })
	if (!input.enabled.includes('ai')) return
	const activeAi = volumeActiveAi(volume)
	const selected = await activeAi.get()
	// A selection is only live if it can still MINT a backend here — the same test
	// `resolveAiAccount` applies, so a selection that survives this always yields one. Hence
	// readable creds, not mere existence: a record whose key is missing or rotated reads back
	// as `creds: undefined` (account.ts) and mints nothing, so honouring it strands the user
	// with a dead agent ("AI is turned off") and nothing but a manual toggle to escape.
	// Everything else that fails here is a name with no record behind it: a fresh install, or
	// an account removed outside the admin facet.
	// The account itself is untouched — its sealed bytes stay on disk for a restored key, and
	// re-selecting it is one click in Settings. Safe to claim, too: selection and accounts
	// share the SAME host-private lane, so this write is invisible to every other host and can
	// never deselect a provider another host is happily using.
	if (selected && (await accounts.get(selected.accountId))?.creds !== undefined) return
	await activeAi.set({ accountId: input.accountId })
}

// A short-lived borrow of the active-AI account, for building the agent's own LLM
// runtime — the one consumer that legitimately needs the creds (to *construct* a
// runtime), so it gets a lease, not the store. `creds` stay inside the caller's `mint`
// closure; `persist` is the only writeback (rotated tokens on refresh). The generic `T`
// keeps @justfiles/app free of any agent/pi-ai dependency; `providerId` lets the caller
// branch on which ai provider is active.
export interface AiAccountLease {
	creds: unknown
	config: unknown // { model } for the active selection
	providerId: string
	persist(creds: unknown): Promise<void>
}

export async function resolveAiAccount<T>(
	volume: Volume,
	mint: (lease: AiAccountLease) => T | Promise<T>,
	opts: { secretCodec?: SecretCodec } = {}
): Promise<T | null> {
	const accounts = volumeAccountStore(volume, opts)
	const sel = await volumeActiveAi(volume).get()
	if (!sel) return null
	const account = await accounts.get(sel.accountId)
	// No account, or creds this host can't read — either way there is no backend to mint;
	// the caller surfaces "turn on AI in Settings" and the record's own lastError says why.
	if (!account || account.creds === undefined) return null
	return mint({
		creds: account.creds,
		config: sel.model !== undefined ? { model: sel.model } : {},
		providerId: account.provider,
		persist: writebackFor(accounts, account)
	})
}

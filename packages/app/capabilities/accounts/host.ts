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
import { type Account, type AccountStore, volumeAccountStore } from './account.ts'
import { type ActiveAiStore, volumeActiveAi } from './active-ai.ts'
import type { AccountInfo, CapabilityId, ProviderInfo } from './contract.ts'
import { accountsAdmin } from './index.ts'
import type { Binding, Provider } from './provider.ts'

export interface AccountsAdminOptions {
	// App ids permitted to reach the admin facet (the first-party Settings app).
	firstParty?: Iterable<string>
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
	if (binding.scope !== undefined && !(account.scopes?.includes(binding.scope) ?? false))
		return undefined
	return binding.bind({
		creds: account.creds,
		config,
		persist: async (creds) => {
			await accounts.put({ ...account, creds })
		}
	})
}

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

// ── Admin facet ─────────────────────────────────────────────────────────

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
	registry: Registry
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
	return info
}

// Admin-facet host. Every method is privileged, so one identity check covers them all;
// reported as UNAVAILABLE (not DENIED) so a non-first-party app can't tell it exists.
function accountsAdminHost(
	providers: Provider[],
	registry: Registry,
	accounts: AccountStore,
	activeAi: ActiveAiStore,
	opts: AccountsAdminOptions = {}
): Capability {
	const allow = new Set(opts.firstParty ?? [])
	const guard = (ctx: { appId: string }) => {
		if (!allow.has(ctx.appId)) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'accounts')
	}
	const invalid = (method: string) =>
		new CapabilityError('CAPABILITY_INVALID_INPUT', 'accounts', method)

	return implementCapability(accountsAdmin, {
		listProviders: async (ctx) => {
			guard(ctx)
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
		listAccounts: async (ctx) => {
			guard(ctx)
			const [all, sel] = await Promise.all([accounts.list(), activeAi.get()])
			return all.map((account) => toAccountInfo(account, sel, registry))
		},
		connect: async (ctx, { providerId, credentials }) => {
			guard(ctx)
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
		setEnabled: async (ctx, { accountId, capability, enabled, config }) => {
			guard(ctx)
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
		disconnect: async (ctx, { accountId }) => {
			guard(ctx)
			await accounts.delete(accountId)
			if ((await activeAi.get())?.accountId === accountId) await activeAi.set(null)
		}
	})
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
	opts: AccountsAdminOptions = {}
): {
	image: Capability
	email: Capability
	calendar: Capability
	accounts: Capability
} {
	const registry: Registry = new Map(providers.map((p) => [p.id, p]))
	const accounts = volumeAccountStore(volume)
	const activeAi = volumeActiveAi(volume)
	return {
		image: imageHost(accounts, activeAi, registry),
		email: emailHost(accounts, registry),
		calendar: calendarHost(accounts, registry),
		accounts: accountsAdminHost(providers, registry, accounts, activeAi, opts)
	}
}

// Seed a credential-less account once, if it doesn't already exist — for a platform-
// managed provider (the built-in AI) that should be present and, on a fresh install, the
// active AI by default. Idempotent: a returning user's active-AI choice is left untouched.
export async function ensureAccount(
	volume: Volume,
	input: { accountId: string; providerId: string; enabled: CapabilityId[] }
): Promise<void> {
	const accounts = volumeAccountStore(volume)
	if (await accounts.get(input.accountId)) return
	await accounts.put({ id: input.accountId, provider: input.providerId, creds: {} })
	if (input.enabled.includes('ai')) {
		const activeAi = volumeActiveAi(volume)
		if ((await activeAi.get()) === null) await activeAi.set({ accountId: input.accountId })
	}
}

// Move an existing account to a new id/provider id, carrying the active-AI pointer with it
// — for a builtin provider whose ids were renamed. No-op when `from` is absent; never
// clobbers an existing `to`.
export async function renameAccount(
	volume: Volume,
	from: string,
	to: { accountId: string; providerId: string }
): Promise<void> {
	const accounts = volumeAccountStore(volume)
	const existing = await accounts.get(from)
	if (!existing) return
	if (!(await accounts.get(to.accountId))) {
		await accounts.put({ ...existing, id: to.accountId, provider: to.providerId })
	}
	await accounts.delete(from)
	const activeAi = volumeActiveAi(volume)
	const active = await activeAi.get()
	if (active?.accountId === from) await activeAi.set({ ...active, accountId: to.accountId })
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
	mint: (lease: AiAccountLease) => T | Promise<T>
): Promise<T | null> {
	const accounts = volumeAccountStore(volume)
	const sel = await volumeActiveAi(volume).get()
	if (!sel) return null
	const account = await accounts.get(sel.accountId)
	if (!account) return null
	return mint({
		creds: account.creds,
		config: sel.model !== undefined ? { model: sel.model } : {},
		providerId: account.provider,
		persist: async (creds) => {
			await accounts.put({ ...account, creds })
		}
	})
}

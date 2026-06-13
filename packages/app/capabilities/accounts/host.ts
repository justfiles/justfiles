// Host-side machinery for the `accounts` model — never shipped to apps. A
// `Provider` declares HOW to authenticate and, per capability, how to mint a
// use-facet impl from stored creds; an `Account` is a connected provider with a
// set of enabled capabilities; an `AccountsStore` persists accounts (encrypting
// creds at rest is the store's concern). `resolveImpl` is the whole of what the
// old broker did: find the account backing a capability, mint the provider impl,
// hand it back — no grants, no scopes.

import type { AiCapability } from '../ai/index.ts'
import { ai } from '../ai/index.ts'
import type { CalendarCapability } from '../calendar/index.ts'
import { calendar } from '../calendar/index.ts'
import type { EmailCapability } from '../email/index.ts'
import { email } from '../email/index.ts'
import { CapabilityError } from '../error.ts'
import { implementCapability } from '../implement.ts'
import type { Capability } from '../types.ts'
import type { AccountInfo, CapabilityId, CredentialsSchema, ProviderInfo } from './contract.ts'
import { accountsAdmin } from './index.ts'

export type Creds = Record<string, unknown>

export interface Provider {
	id: string
	name: string
	auth:
		| { kind: 'form'; credentialsSchema: CredentialsSchema }
		| { kind: 'oauth'; signIn(): Promise<{ accountId: string; creds: Creds }> }
	// Presence of a key = "this provider can back that capability". One object
	// expresses `google = email + calendar` — what the per-capability broker
	// registry could not. A factory also receives the account's per-capability
	// config (e.g. ai → the selected model) so it can mint a configured impl;
	// providers that don't need it (email/calendar) just ignore the second arg.
	mint: Partial<{
		email(creds: Creds): EmailCapability
		calendar(creds: Creds): CalendarCapability
		ai(creds: Creds, config: unknown): AiCapability
	}>
	// Optional per-capability projection of an account's stored config into the
	// UI-facing config `listAccounts` returns (e.g. ai → selected + available
	// models). Absent → the raw stored config is surfaced unchanged.
	describe?: Partial<Record<CapabilityId, (config: unknown) => unknown>>
}

export interface Account {
	accountId: string
	providerId: string
	creds: Creds
	// Key present = enabled; value = per-capability config (e.g. ai → { model }).
	enabled: Partial<Record<CapabilityId, unknown>>
	lastError?: string
}

export interface AccountsStore {
	list(): Promise<Account[]>
	get(accountId: string): Promise<Account | undefined>
	put(account: Account): Promise<void>
	delete(accountId: string): Promise<void>
}

export type ProviderRegistry = Map<string, Provider>

// Resolve the live implementation of `capability` for an optional accountId. With
// no accountId it picks the first account that enabled the capability (single
// account per capability today; multi-account fan-out is a later slice).
async function resolveImpl<C>(
	capability: CapabilityId,
	accountId: string | undefined,
	providers: ProviderRegistry,
	accounts: AccountsStore
): Promise<C> {
	const account = (await accounts.list()).find(
		(a) => capability in a.enabled && (accountId === undefined || a.accountId === accountId)
	)
	const mint = account && providers.get(account.providerId)?.mint[capability]
	if (!mint) throw new CapabilityError('CAPABILITY_UNAVAILABLE', capability)
	return (mint as (creds: Creds, config: unknown) => C)(account.creds, account.enabled[capability])
}

// Use-facet hosts: pure delegation through `resolveImpl`. Wired into the kernel's
// capability registry by the host (frieren/quay).
export const emailHost = (providers: ProviderRegistry, accounts: AccountsStore): Capability =>
	implementCapability(email, {
		listUnread: async (_c, i) =>
			(await resolveImpl<EmailCapability>('email', i.accountId, providers, accounts)).listUnread(i),
		readDetail: async (_c, i) =>
			(await resolveImpl<EmailCapability>('email', i.accountId, providers, accounts)).readDetail(i),
		markRead: async (_c, i) =>
			(await resolveImpl<EmailCapability>('email', i.accountId, providers, accounts)).markRead(i)
	})

export const calendarHost = (providers: ProviderRegistry, accounts: AccountsStore): Capability =>
	implementCapability(calendar, {
		listToday: async (_c, i) =>
			(
				await resolveImpl<CalendarCapability>('calendar', i.accountId, providers, accounts)
			).listToday(i)
	})

// `ai.generateText` carries no accountId, so it resolves the single ai-enabled
// account. The minted impl is configured with that account's `enabled.ai` (the
// selected model), so a model pick in Settings takes effect on the next call.
export const aiHost = (providers: ProviderRegistry, accounts: AccountsStore): Capability =>
	implementCapability(ai, {
		generateText: async (_c, i) =>
			(await resolveImpl<AiCapability>('ai', undefined, providers, accounts)).generateText(i)
	})

export interface AccountsAdminOptions {
	// App ids permitted to reach the admin facet (the first-party Settings app).
	firstParty?: Iterable<string>
}

// Admin-facet host. Every method is privileged, so one identity check covers them
// all; reported as UNAVAILABLE (not DENIED) so a non-first-party app can't even
// tell the facet exists — same posture as the volume `system` allowlist.
export const accountsAdminHost = (
	providers: ProviderRegistry,
	accounts: AccountsStore,
	opts: AccountsAdminOptions = {}
): Capability => {
	const allow = new Set(opts.firstParty ?? [])
	const guard = (ctx: { appId: string }) => {
		if (!allow.has(ctx.appId)) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'accounts')
	}
	const invalid = (method: string) =>
		new CapabilityError('CAPABILITY_INVALID_INPUT', 'accounts', method)

	return implementCapability(accountsAdmin, {
		listProviders: async (ctx) => {
			guard(ctx)
			return [...providers.values()].map(toProviderInfo)
		},
		listAccounts: async (ctx) => {
			guard(ctx)
			return (await accounts.list()).map((a) => toAccountInfo(a, providers.get(a.providerId)))
		},
		connect: async (ctx, { providerId, credentials }) => {
			guard(ctx)
			const provider = providers.get(providerId)
			if (!provider) throw invalid('connect')
			// Preserve an existing account's enabled toggles across a re-connect
			// (e.g. updating a token), keyed by the resolved accountId.
			if (provider.auth.kind === 'oauth') {
				const { accountId, creds } = await provider.auth.signIn()
				const prev = await accounts.get(accountId)
				await accounts.put({ accountId, providerId, creds, enabled: prev?.enabled ?? {} })
				return { accountId }
			}
			if (!credentials) throw invalid('connect')
			// Form providers carry no verified identity; key the account by provider
			// (one account per form provider for now).
			const accountId = providerId
			const prev = await accounts.get(accountId)
			await accounts.put({
				accountId,
				providerId,
				creds: credentials,
				enabled: prev?.enabled ?? {}
			})
			return { accountId }
		},
		setEnabled: async (ctx, { accountId, capability, enabled, config }) => {
			guard(ctx)
			const account = await accounts.get(accountId)
			if (!account) throw invalid('setEnabled')
			const next: Partial<Record<CapabilityId, unknown>> = { ...account.enabled }
			if (enabled) next[capability] = config ?? next[capability] ?? {}
			else delete next[capability]
			await accounts.put({ ...account, enabled: next })
		},
		disconnect: async (ctx, { accountId }) => {
			guard(ctx)
			await accounts.delete(accountId)
		}
	})
}

function toProviderInfo(p: Provider): ProviderInfo {
	return {
		id: p.id,
		name: p.name,
		authKind: p.auth.kind,
		capabilities: Object.keys(p.mint) as CapabilityId[],
		credentialsSchema: p.auth.kind === 'form' ? p.auth.credentialsSchema : undefined
	}
}

function toAccountInfo(a: Account, provider?: Provider): AccountInfo {
	const config: Partial<Record<CapabilityId, unknown>> = {}
	for (const capability of Object.keys(a.enabled) as CapabilityId[]) {
		const describe = provider?.describe?.[capability]
		config[capability] = describe ? describe(a.enabled[capability]) : a.enabled[capability]
	}
	return {
		accountId: a.accountId,
		providerId: a.providerId,
		enabled: Object.keys(a.enabled) as CapabilityId[],
		config,
		lastError: a.lastError
	}
}

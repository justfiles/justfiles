// Host-side machinery for the `accounts` model — never shipped to apps. There is no
// generic provider broker anymore: each use-facet host is self-contained, importing
// its provider client code directly and deriving which connections back it from the
// static PROVIDER_CATALOG + the connection's granted scopes (see provider-caps.ts).
// Storage is connections (creds + scopes) plus a single active-AI pointer — the
// per-capability enablement table is gone; capabilities are DERIVED.
//
// Hosts inject only what differs per platform: OAuth acquisition (`signIn`), the
// ChatGPT `ai` mint + model picker, and the platform-AI generate fn. The credential-
// bearing stores are built once internally from the Volume and never cross the package
// boundary; callers pass a Volume and hold capabilities.

import type { Volume } from '@justfiles/fs'
import type { AiCapability } from '../ai/index.ts'
import { ai } from '../ai/index.ts'
import type { CalendarCapability } from '../calendar/index.ts'
import { calendar } from '../calendar/index.ts'
import type { EmailCapability } from '../email/index.ts'
import { email } from '../email/index.ts'
import { CapabilityError } from '../error.ts'
import { implementCapability } from '../implement.ts'
import type { Capability } from '../types.ts'
import { type ActiveAiStore, volumeActiveAi } from './active-ai.ts'
import {
	type Connection,
	type ConnectionStore,
	type Creds,
	volumeConnectionStore
} from './connection.ts'
import type { AccountInfo, CapabilityId, ProviderInfo } from './contract.ts'
import { accountsAdmin } from './index.ts'
import { migrateAccountsToConnections } from './migrate.ts'
import { backs, capabilitiesOf, PROVIDER_CATALOG, scopeFor } from './provider-caps.ts'
import {
	authedFetch,
	createGmailEmail,
	createGoogleCalendar,
	type GoogleClient,
	type GoogleCreds,
	type OAuthSignIn
} from './providers/google.ts'
import { createIcloudCalendar, type IcloudCalendarCredentials } from './providers/icloud.ts'

export type { Creds } from './connection.ts'

type AiModel = { id: string; name: string }

// The host-specific seams, keyed by provider kind. The client code is imported
// directly; only these injected parts vary per platform (daemon vs Worker). A provider
// kind is offered by a host only when its deps are supplied.
export interface AccountsDeps {
	google?: { signIn: OAuthSignIn; refreshClient: GoogleClient | null }
	// iCloud is a static form provider — no host seam, just opt in.
	icloud?: boolean
	chatgpt?: {
		signIn: OAuthSignIn
		mintAi: (creds: Creds, config: unknown) => AiCapability
		models: () => AiModel[]
		defaultModel: () => string
	}
	// Platform AI ("Spud AI"): mint `ai` over a host-supplied generate fn. Kept as a
	// bare function so this package needs no @justfiles/agent dependency.
	spud?: { generate: (system: string, prompt: string) => Promise<string> }
}

export interface AccountsAdminOptions {
	// App ids permitted to reach the admin facet (the first-party Settings app).
	firstParty?: Iterable<string>
}

// ── Client resolution (scope-derived, per capability) ─────────────────────

// Build the email use-facet client for a connection, or undefined if this host doesn't
// serve its kind. Only Google backs email today; a new provider is one more branch.
function emailClient(c: Connection, deps: AccountsDeps): EmailCapability | undefined {
	if (c.kind === 'google' && deps.google)
		return createGmailEmail(authedFetch(c.creds as GoogleCreds, deps.google.refreshClient))
	return undefined
}

function calendarClient(c: Connection, deps: AccountsDeps): CalendarCapability | undefined {
	if (c.kind === 'google' && deps.google)
		return createGoogleCalendar(authedFetch(c.creds as GoogleCreds, deps.google.refreshClient))
	if (c.kind === 'icloud' && deps.icloud)
		return createIcloudCalendar(c.creds as unknown as IcloudCalendarCredentials)
	return undefined
}

// Mint the `ai` use facet for a connection + selected model. ChatGPT is host-injected
// (built over the host's LLM runtime); Spud AI wraps the platform generate fn.
function aiClient(c: Connection, config: unknown, deps: AccountsDeps): AiCapability | undefined {
	if (c.kind === 'chatgpt' && deps.chatgpt) return deps.chatgpt.mintAi(c.creds, config)
	if (c.kind === 'spud' && deps.spud) {
		const generate = deps.spud.generate
		return {
			generateText: async ({ system, prompt }) => ({
				text: await generate(typeof system === 'string' ? system : '', prompt)
			})
		}
	}
	return undefined
}

// Connections backing `capability` (optionally one), each turned into a live client.
// The scope-derived replacement for the old provider-registry resolver.
async function resolveClients<C>(
	connections: ConnectionStore,
	capability: CapabilityId,
	client: (c: Connection) => C | undefined,
	accountId?: string
): Promise<{ accountId: string; impl: C }[]> {
	const out: { accountId: string; impl: C }[] = []
	for (const c of await connections.list()) {
		if (!backs(c, capability)) continue
		if (accountId !== undefined && c.id !== accountId) continue
		const impl = client(c)
		if (impl) out.push({ accountId: c.id, impl })
	}
	return out
}

// Fan a list call across every backing connection (or one), stamp each result with its
// source, and concatenate. No backing connection ⇒ UNAVAILABLE (the "not configured"
// signal, distinct from a configured-but-empty inbox).
async function fanOut<C, R extends { accountId?: string }>(
	connections: ConnectionStore,
	capability: CapabilityId,
	client: (c: Connection) => C | undefined,
	accountId: string | undefined,
	call: (impl: C) => Promise<R[]>
): Promise<R[]> {
	const targets = await resolveClients(connections, capability, client, accountId)
	if (targets.length === 0) throw new CapabilityError('CAPABILITY_UNAVAILABLE', capability)
	const lists = await Promise.all(
		targets.map(async (t) => (await call(t.impl)).map((r) => ({ ...r, accountId: t.accountId })))
	)
	return lists.flat()
}

// Single-connection resolution (readDetail/markRead target the summary's accountId).
async function resolveOne<C>(
	connections: ConnectionStore,
	capability: CapabilityId,
	client: (c: Connection) => C | undefined,
	accountId?: string
): Promise<C> {
	const [first] = await resolveClients(connections, capability, client, accountId)
	if (!first) throw new CapabilityError('CAPABILITY_UNAVAILABLE', capability)
	return first.impl
}

// ── Use-facet hosts ───────────────────────────────────────────────────────

function emailHost(connections: ConnectionStore, deps: AccountsDeps): Capability {
	const client = (c: Connection) => emailClient(c, deps)
	return implementCapability(email, {
		listUnread: (_c, i) =>
			fanOut(connections, 'email', client, i.accountId, (impl) => impl.listUnread(i)),
		readDetail: async (_c, i) =>
			(await resolveOne(connections, 'email', client, i.accountId)).readDetail(i),
		markRead: async (_c, i) =>
			(await resolveOne(connections, 'email', client, i.accountId)).markRead(i)
	})
}

function calendarHost(connections: ConnectionStore, deps: AccountsDeps): Capability {
	const client = (c: Connection) => calendarClient(c, deps)
	return implementCapability(calendar, {
		listToday: (_c, i) =>
			fanOut(connections, 'calendar', client, i.accountId, (impl) => impl.listToday(i))
	})
}

// `ai.generateText` carries no accountId, so it resolves the single active-AI selection
// and mints with its selected model. A model pick in Settings takes effect next call.
function aiHost(
	connections: ConnectionStore,
	activeAi: ActiveAiStore,
	deps: AccountsDeps
): Capability {
	return implementCapability(ai, {
		generateText: async (_c, i) => {
			const sel = await activeAi.get()
			const conn = sel ? await connections.get(sel.connectionId) : undefined
			const impl = conn
				? aiClient(conn, sel?.model !== undefined ? { model: sel.model } : {}, deps)
				: undefined
			if (!impl) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'ai')
			return impl.generateText(i)
		}
	})
}

// ── Admin facet ─────────────────────────────────────────────────────────

// The per-capability config the UI renders: only `ai` is meaningful (the model
// picker); email/calendar carry none.
function aiConfig(kind: string, model: string | undefined, deps: AccountsDeps): unknown {
	if (kind === 'chatgpt' && deps.chatgpt)
		return { model: model ?? deps.chatgpt.defaultModel(), models: deps.chatgpt.models() }
	return {}
}

// Assemble one connection's account-centric projection: enablement is DERIVED
// (email/calendar from scopes, ai from the active selection).
function toAccountInfo(
	c: Connection,
	sel: { connectionId: string; model?: string } | null,
	deps: AccountsDeps
): AccountInfo {
	const enabled: CapabilityId[] = []
	if (backs(c, 'email')) enabled.push('email')
	if (backs(c, 'calendar')) enabled.push('calendar')
	const isActiveAi = sel?.connectionId === c.id
	if (isActiveAi) enabled.push('ai')
	const config: Partial<Record<CapabilityId, unknown>> = {}
	if (isActiveAi) config.ai = aiConfig(c.kind, sel?.model, deps)
	const info: AccountInfo = { accountId: c.id, providerId: c.kind, enabled, config }
	if (c.lastError) info.lastError = c.lastError
	return info
}

// Admin-facet host. Every method is privileged, so one identity check covers them all;
// reported as UNAVAILABLE (not DENIED) so a non-first-party app can't tell it exists.
function accountsAdminHost(
	deps: AccountsDeps,
	connections: ConnectionStore,
	activeAi: ActiveAiStore,
	opts: AccountsAdminOptions = {}
): Capability {
	const allow = new Set(opts.firstParty ?? [])
	const guard = (ctx: { appId: string }) => {
		if (!allow.has(ctx.appId)) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'accounts')
	}
	const invalid = (method: string) =>
		new CapabilityError('CAPABILITY_INVALID_INPUT', 'accounts', method)

	// Provider kinds this host offers (deps supplied), in catalog order.
	const present: string[] = [
		...(deps.google ? ['google'] : []),
		...(deps.icloud ? ['icloud'] : []),
		...(deps.chatgpt ? ['chatgpt'] : []),
		...(deps.spud ? ['spud'] : [])
	]
	const signInFor = (kind: string): OAuthSignIn | undefined =>
		kind === 'google' ? deps.google?.signIn : kind === 'chatgpt' ? deps.chatgpt?.signIn : undefined

	return implementCapability(accountsAdmin, {
		listProviders: async (ctx) => {
			guard(ctx)
			return present.flatMap((kind) => {
				const meta = PROVIDER_CATALOG[kind]
				if (!meta) return []
				const info: ProviderInfo = {
					id: kind,
					name: meta.name,
					authKind: meta.authKind,
					capabilities: capabilitiesOf(kind)
				}
				if (meta.builtin) info.builtin = true
				if (meta.credentialsSchema) info.credentialsSchema = meta.credentialsSchema
				return [info]
			})
		},
		listAccounts: async (ctx) => {
			guard(ctx)
			const [conns, sel] = await Promise.all([connections.list(), activeAi.get()])
			return conns.map((c) => toAccountInfo(c, sel, deps))
		},
		connect: async (ctx, { providerId, credentials }) => {
			guard(ctx)
			const meta = PROVIDER_CATALOG[providerId]
			if (!meta || !present.includes(providerId)) throw invalid('connect')
			if (meta.authKind === 'oauth') {
				const signIn = signInFor(providerId)
				if (!signIn) throw invalid('connect')
				// Connect requests no capability scopes yet — just the identity the
				// provider needs to derive accountId. Preserve any prior grants so a
				// re-connect (e.g. token refresh) keeps enabled services on.
				const { accountId, creds, scopes } = await signIn([])
				const prev = await connections.get(accountId)
				const merged = [...new Set([...(prev?.scopes ?? []), ...(scopes ?? [])])]
				const connection: Connection = { id: accountId, kind: providerId, creds }
				if (merged.length > 0) connection.scopes = merged
				await connections.put(connection)
				return { accountId }
			}
			if (!credentials) throw invalid('connect')
			// Form providers carry no verified identity; key by provider (one each).
			await connections.put({ id: providerId, kind: providerId, creds: credentials })
			return { accountId: providerId }
		},
		setEnabled: async (ctx, { accountId, capability, enabled, config }) => {
			guard(ctx)
			const conn = await connections.get(accountId)
			if (!conn) throw invalid('setEnabled')
			// ai is single-active: the selection pointer, not a scope.
			if (capability === 'ai') {
				if (enabled) {
					const model = (config as { model?: string } | undefined)?.model
					const prev = await activeAi.get()
					const chosen = model ?? (prev?.connectionId === accountId ? prev.model : undefined)
					await activeAi.set(
						chosen !== undefined
							? { connectionId: accountId, model: chosen }
							: { connectionId: accountId }
					)
				} else if ((await activeAi.get())?.connectionId === accountId) {
					await activeAi.set(null)
				}
				return
			}
			// email/calendar enablement lives in the connection's granted scopes.
			const scope = scopeFor(conn.kind, capability)
			// Form providers (iCloud) have no scope to toggle — the capability is granted
			// by the connection existing; to stop it, disconnect the account.
			if (!scope) return
			const have = new Set(conn.scopes ?? [])
			if (enabled) {
				if (have.has(scope)) return
				// Incremental consent: re-run sign-in for the widened scope set.
				const signIn = signInFor(conn.kind)
				if (!signIn) throw invalid('setEnabled')
				const widened = [...new Set([...(conn.scopes ?? []), scope])]
				const res = await signIn(widened)
				await connections.put({
					id: conn.id,
					kind: conn.kind,
					creds: res.creds,
					scopes: res.scopes ?? widened
				})
			} else {
				have.delete(scope)
				const next: Connection = { id: conn.id, kind: conn.kind, creds: conn.creds }
				if (have.size > 0) next.scopes = [...have]
				await connections.put(next)
			}
		},
		disconnect: async (ctx, { accountId }) => {
			guard(ctx)
			await connections.delete(accountId)
			if ((await activeAi.get())?.connectionId === accountId) await activeAi.set(null)
		}
	})
}

// ── Entry points ──────────────────────────────────────────────────────────

// One factory: the credential-bearing stores are built once internally from the Volume
// and never cross the package boundary. Migrates legacy accounts on first use.
export async function accountsCapabilities(
	deps: AccountsDeps,
	volume: Volume,
	opts: AccountsAdminOptions = {}
): Promise<{ ai: Capability; email: Capability; calendar: Capability; accounts: Capability }> {
	await migrateAccountsToConnections(volume)
	const connections = volumeConnectionStore(volume)
	const activeAi = volumeActiveAi(volume)
	return {
		ai: aiHost(connections, activeAi, deps),
		email: emailHost(connections, deps),
		calendar: calendarHost(connections, deps),
		accounts: accountsAdminHost(deps, connections, activeAi, opts)
	}
}

// Seed a credential-less connection once, if it doesn't already exist — for a platform-
// managed provider (Spud AI) that should be present and, on a fresh install, the active
// AI by default. Idempotent: a returning user's active-AI choice is left untouched.
export async function ensureAccount(
	volume: Volume,
	input: { accountId: string; providerId: string; enabled: CapabilityId[] }
): Promise<void> {
	await migrateAccountsToConnections(volume)
	const connections = volumeConnectionStore(volume)
	if (await connections.get(input.accountId)) return
	await connections.put({ id: input.accountId, kind: input.providerId, creds: {} })
	if (input.enabled.includes('ai')) {
		const activeAi = volumeActiveAi(volume)
		if ((await activeAi.get()) === null) await activeAi.set({ connectionId: input.accountId })
	}
}

// A short-lived borrow of the active-AI connection, for building the agent's own LLM
// runtime — the one consumer that legitimately needs the token (to *construct* a
// runtime), so it gets a lease, not the store. `creds` stay inside the caller's `mint`
// closure; `persist` is the only writeback (rotated tokens on refresh). The generic `T`
// keeps @justfiles/app free of any agent/pi-ai dependency; `providerId` lets the caller
// branch on which ai provider is active.
export interface AiAccountLease {
	creds: Creds
	config: unknown // { model } for the active selection
	providerId: string
	persist(creds: Creds): Promise<void>
}

export async function resolveAiAccount<T>(
	volume: Volume,
	mint: (lease: AiAccountLease) => T | Promise<T>
): Promise<T | null> {
	await migrateAccountsToConnections(volume)
	const connections = volumeConnectionStore(volume)
	const sel = await volumeActiveAi(volume).get()
	if (!sel) return null
	const conn = await connections.get(sel.connectionId)
	if (!conn) return null
	return mint({
		creds: conn.creds,
		config: sel.model !== undefined ? { model: sel.model } : {},
		providerId: conn.kind,
		persist: async (creds) => {
			await connections.put({ ...conn, creds })
		}
	})
}

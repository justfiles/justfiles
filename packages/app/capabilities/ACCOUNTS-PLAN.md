# Plan: unify `email` · `calendar` · `ai` onto **accounts**

Applies the `use`/`admin` facet pattern (shipped for `ai`, see commit `c32a636`) to the
rest of the credentialed capabilities, and replaces the separate `integrations` +
`ai/admin` surfaces with one **accounts** model. The driver: one Google account must
back both `email` and `calendar` (1-admin-to-many-use), which the current
`integration = (provider × capability)` model cannot express.

## Model

Four concepts, no broker:

- **provider** — *host-side.* Declares how to authenticate (`form` | `oauth`), and **per
  capability**, how to mint a use-facet impl from stored creds. One object expresses
  `google = email + calendar`. This is the thing the old per-capability broker registry
  couldn't express.
- **account** — *persisted.* `{ accountId, providerId, creds, enabled }`. `enabled` is a
  map: key present = that capability is on, value = its config (e.g. `ai → { model }`).
- **capability** — *unchanged use-facet contracts* (`email.listUnread`,
  `calendar.listToday`, `ai.generateText`).
- **dispatcher** — *~10 lines.* Resolve the account backing a capability → mint the
  provider impl → call the method.

One app-facing **`accounts/admin`** facet (subsumes `integrations` + `ai/admin`), served
only to first-party Settings, appId-gated. The Settings UI becomes macOS "Internet
Accounts": add account (form or OAuth sheet) → toggle its capabilities → configure
per-capability.

### Why no broker

`packages/app/capabilities/broker.ts` bundled six jobs; only **resolve account → mint
provider → dispatch** is load-bearing, and that becomes `resolveImpl` below. Its
`grants` / `methodScopes` were never called outside tests (`createBroker` has no live
caller). Worse, its provider registry is **per capability** — to make Google back both
`email` and `calendar` you'd register it twice, reintroducing the duplication we're
killing. A provider that *declares* its capability set expresses Google once. So the
broker is deleted, not adapted.

## Contracts

### App-facing — `accounts/admin`

```ts
// packages/app/capabilities/accounts/contract.ts
export type CapabilityId = 'email' | 'calendar' | 'ai'

// A connectable provider, projected for the UI. No host internals.
export interface ProviderInfo {
	id: string                              // 'fastmail' | 'icloud' | 'google' | 'chatgpt'
	name: string
	authKind: 'form' | 'oauth'
	capabilities: CapabilityId[]            // what an account from this provider can back
	credentialsSchema?: CredentialsSchema   // present iff authKind === 'form'
}

// A connected account, projected for the UI. NEVER carries credentials.
export interface AccountInfo {
	accountId: string
	providerId: string
	enabled: CapabilityId[]
	// Per-capability settings to render (e.g. ai → selected + available models).
	config: Partial<Record<CapabilityId, unknown>>
	lastError?: string
}

export interface AccountsAdminCapability {
	listProviders(input: Record<string, never>): Promise<ProviderInfo[]>
	listAccounts(input: Record<string, never>): Promise<AccountInfo[]>
	// form providers: pass `credentials`. oauth providers: omit — host runs the flow
	// (browser + redirect catch) and derives accountId from the verified identity.
	connect(input: { providerId: string; credentials?: Record<string, string> }): Promise<{ accountId: string }>
	// The "service" checkbox. `config` sets per-capability settings (e.g. ai model).
	setEnabled(input: { accountId: string; capability: CapabilityId; enabled: boolean; config?: unknown }): Promise<void>
	disconnect(input: { accountId: string }): Promise<void>
}

// Lifted verbatim from the old integrations contract.
export interface CredentialsSchema {
	type: 'object'
	properties: Record<string, { type: 'string'; minLength?: number; description?: string }>
	required?: string[]
}
```

Old surface → new (7 methods across 2 facets collapse to 5 on one):

| was | now |
|---|---|
| `integrations.list` | `listProviders` + `listAccounts` |
| `integrations.connect` / `disconnect` | `connect` (form) / `disconnect` |
| `aiAdmin.signIn` | `connect` (oauth) |
| `aiAdmin.status` | `listAccounts` (the ai-enabled account) |
| `aiAdmin.selectModel` | `setEnabled(ai, true, { model })` |
| `aiAdmin.signOut` | `setEnabled(ai, false)` or `disconnect` |

### Host-side — provider, account, store

```ts
// packages/app/capabilities/accounts/host.ts — host-only, never shipped to apps.
export type Creds = Record<string, unknown>

export interface Provider {
	id: string
	name: string
	auth:
		| { kind: 'form'; credentialsSchema: CredentialsSchema }
		| { kind: 'oauth'; signIn(): Promise<{ accountId: string; creds: Creds }> }
	// Presence of a key = "this provider backs that capability".
	mint: Partial<{
		email(creds: Creds): EmailCapability
		calendar(creds: Creds): CalendarCapability
		ai(creds: Creds): AiCapability
	}>
}

export interface Account {
	accountId: string
	providerId: string
	creds: Creds                                    // encrypted at rest by the store
	enabled: Partial<Record<CapabilityId, unknown>> // key present = on; value = config
	lastError?: string
}

export interface AccountsStore {
	list(): Promise<Account[]>
	get(accountId: string): Promise<Account | undefined>
	put(account: Account): Promise<void>
	delete(accountId: string): Promise<void>
}
```

### Dispatcher — the entire replacement for `broker.ts`

```ts
async function resolveImpl<C>(
	capability: CapabilityId, accountId: string | undefined,
	providers: Map<string, Provider>, accounts: AccountsStore
): Promise<C> {
	const account = (await accounts.list()).find(
		(a) => capability in a.enabled && (accountId === undefined || a.accountId === accountId)
	)
	const mint = account && providers.get(account.providerId)?.mint[capability]
	if (!account || !mint) throw new CapabilityError('CAPABILITY_UNAVAILABLE', capability, '')
	return mint(account.creds) as C
}

// Each use-facet host is pure delegation. calendar/ai are identical.
export const emailHost = (providers: Map<string, Provider>, accounts: AccountsStore) =>
	implementCapability(email, {
		listUnread: async (_c, i) => (await resolveImpl<EmailCapability>('email', i.accountId, providers, accounts)).listUnread(i),
		readDetail: async (_c, i) => (await resolveImpl<EmailCapability>('email', i.accountId, providers, accounts)).readDetail(i),
		markRead:   async (_c, i) => (await resolveImpl<EmailCapability>('email', i.accountId, providers, accounts)).markRead(i)
	})
```

### Declaring providers — the 1→many payoff is just an object

```ts
const fastmail: Provider = {
	id: 'fastmail', name: 'Fastmail',
	auth: { kind: 'form', credentialsSchema: fastmailSchema },
	mint: { email: (c) => createFastmailEmail(c) }                 // email only
}

const google: Provider = {
	id: 'google', name: 'Google',
	auth: { kind: 'oauth', signIn: googleOAuth },                  // → { accountId: <email>, creds }
	mint: {
		email:    (c) => createGoogleEmail(c),
		calendar: (c) => createGoogleCalendar(c)                   // ONE account, two capabilities
	}
}
```

`connect`/`setEnabled` host, showing the two auth modalities and the single gate:

```ts
connect: async (ctx, { providerId, credentials }) => {
	gate(ctx, allow)                                               // one allowlist, all admin methods
	const p = providers.get(providerId) ?? fail(providerId)
	const { accountId, creds } = p.auth.kind === 'oauth'
		? await p.auth.signIn()                                    // chatgpt, google
		: { accountId: deriveId(providerId, credentials), creds: credentials! }
	await accounts.put({ accountId, providerId, creds, enabled: {} })
	return { accountId }
},
setEnabled: async (ctx, { accountId, capability, enabled, config }) => {
	gate(ctx, allow)
	const a = (await accounts.get(accountId)) ?? fail(accountId)
	if (enabled) a.enabled[capability] = config ?? a.enabled[capability] ?? {}
	else delete a.enabled[capability]
	await accounts.put(a)
}
```

## Slices

Each is shippable (live product keeps working at the boundary) and verifiable. Ordered
so the 1→many payoff lands last on a finished machine. No migration/back-compat —
nothing has shipped.

### Slice 1 — Accounts substrate + email/calendar live in frieren

The heart. Builds the substrate and proves it end-to-end for the two existing form
providers.

- New `packages/app/capabilities/accounts`: contract, host types, `resolveImpl`, the
  `accounts/admin` host (appId-gated, one allowlist).
- **Delete** `broker.ts`, `defineProviderBackedCapability`, `capabilities/calendar/host.ts`,
  the `integrations` capability + its REST routes.
- Re-express the iCloud calendar + Fastmail email providers as `Provider` objects (their
  `create` fns already exist — just rehoused under `mint`).
- frieren: `AccountsStore` over the encrypted KV (reuse `integrations/crypto.ts`);
  provider registry `[fastmail, icloud]`; wire `email` + `calendar` use-facet hosts into
  the live `capabilityRegistry` (`frieren.app.ts`).
- Retire the `Integrations` registry's **storage + admin** role; keep its
  command-activation (rate-limit/audit/coalescer) as a hook off `connect`/`setEnabled`
  so the **agent's email/calendar commands keep working**, now sourced from the accounts
  store.
- Settings: add the accounts-driven section (list providers/accounts, connect via form,
  toggle email/calendar, disconnect). Leave the existing `ai` section on `aiAdmin`
  untouched (collapses in Slice 2).

**End state:** in Settings, connect Fastmail (form) → toggle email → an app's
`email.listUnread` returns mail; same for iCloud → calendar. Agent still runs its
email/calendar commands. `ai` unchanged.
**Verify:** unit tests for store + `resolveImpl` + providers; `verify:ui` — connect
Fastmail, snapshot the inbox app; trigger an agent calendar query.

### Slice 2 — Fold `ai`/ChatGPT into accounts; delete `ai/admin`

Generalizes the substrate to the OAuth + per-capability-config cases, on the quay host.

- Add the `oauth` modality wiring: `chatgpt` provider whose `signIn` is the existing
  loopback flow (`loginOpenAICodex` from `aiAdmin.ts`), returning `{ accountId, creds }`.
- Per-capability config: `ai`'s `setEnabled` config carries `{ model }`; `listAccounts`
  projects `{ model, models }` into `AccountInfo.config.ai` (subsumes
  `selectModel`/`models`/`status`).
- quay: accounts store (over the Volume, reuse `connections.ts` crypto path), provider
  registry `[chatgpt]`, serve `accounts/admin` + the `ai` use-facet host; quay agent
  resolves the `ai`-enabled account from the store instead of reading `connections.ts`
  directly.
- **Delete** `ai/admin` contract, `aiAdmin.ts`, the bespoke
  `readChatgpt/writeChatgpt/clearChatgpt`.
- Settings: collapse the `ai` section into the accounts section (it's now just another
  provider with a model dropdown). One facet declared, not two.

**End state:** ChatGPT sign-in, model pick, and sign-out all flow through the same
Internet-Accounts UI; the agent uses the resolved account.
**Verify:** Settings → connect ChatGPT (browser flow) → pick a model →
`ai.generateText` works and the agent runs.

### Slice 3 — Google provider + multi-account aggregation (the goal, demonstrated)

The payoff: one account backing two capabilities, coexisting with others.

- Add the `google` provider (`oauth`, `mint: { email, calendar }`) + the Google
  email/calendar clients. **No new mechanism** — it's one object.
- Incremental consent: `setEnabled('calendar', true)` on a Google account requests the
  calendar scope if `email` was connected first (provider-declared scope per capability;
  re-runs the OAuth sheet when scopes widen).
- Multi-account fan-out (deferred from earlier): when `accountId` is omitted,
  `calendar.listToday` / `email.listUnread` aggregate across **all** enabled accounts and
  concatenate (results already tag `accountId`). `resolveImpl` gains a `resolveAll`
  sibling; use-facet hosts map+flatten.

**End state:** connect one Google account, tick email + calendar; the calendar view
merges Google + iCloud, the inbox merges Google + Fastmail.
**Verify:** `verify:ui` — connect Google, toggle both, snapshot a merged
calendar/inbox; confirm one account row, not two.

## Residual / out of scope

- **Agent commands vs capability calls.** ✅ Done (see `ACCOUNTS-MIGRATION.md` Phase 3).
  The agent's bespoke `email`/`calendar` CLI commands are retired; it now reaches the
  use-facet capabilities directly through an agent→capability bridge
  (`apps/frieren/worker/accounts/agent-tools.ts`), with audit + rate-limit re-homed onto
  the capability boundary (`accounts/guard.ts`).
- **Per-app / per-method authorization.** The broker's `grants` + `methodScopes`
  (read-vs-write, account-scoped per app) were never live; dropped. When a real consumer
  appears, they reattach as a thin check inside `resolveImpl`, fed by manifest grants —
  kept orthogonal to `enabled` (which accounts back a capability), exactly the two-axis
  split macOS/Android use (account backing vs per-app permission).

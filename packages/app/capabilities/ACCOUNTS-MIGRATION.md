# Plan: hide `AccountsStore`, unify on the Volume, sever creds from consumers

Follow-on to `ACCOUNTS-PLAN.md`. That plan unified `email`/`calendar`/`ai` onto the
**provider → account → capability** model. This plan finishes the job: the accounts
store becomes an *internal* detail of `@justfiles/app`, host entry points take a
`Volume`, and **no consumer ever holds a credential** — they hold a capability or a
minted operation.

---

## Context — why

Two gaps remain after `ACCOUNTS-PLAN.md`:

1. **`AccountsStore` is exposed and reimplemented per platform.** quay implements it
   over the Volume (`apps/quay/quayd/accounts.ts`), frieren over encrypted KV
   (`apps/frieren/worker/accounts/store.ts`). But the Volume is the syncable substrate
   present on **every** platform — the eventual aim is to sync quay's Volume with
   frieren's, so accounts ride it everywhere anyway. The volume-backed store is the
   *universal* one; each native host shouldn't re-derive it, and the interface
   shouldn't be public.

2. **Credentials leak past the capability boundary.** The model's whole point: a
   `Provider.mint` reads creds host-side and returns a capability/operation; consumers
   hold the operation, never the secret — *vend an operation, not the secret*
   (ssh-agent, not a key handout). Two consumers violate it:
   - quay's agent reads the raw token to build its LLM runtime (`resolveAi → { access, model }`).
   - frieren's `CommandActivator` bakes creds into the agent's bash commands
     (`factory(creds, accountId)`), a parallel integration path that competes with the
     capability system.

**Direction.** Make the volume-backed store internal to `@justfiles/app`; host entry
points take a `Volume`; every consumer reaches a capability or a minted operation,
never creds. Accounts ride the Volume **in the clear** (the Volume is the trust
boundary; encryption returns later as a codec swap). The agent reaches email/calendar
through **capabilities**, retiring the creds-laden CLI commands.

The agent's *own* LLM backend is the one case that legitimately needs the token to
build a runtime — handled by a **generic borrow** that keeps the token sealed in a
closure (proven by the spike below).

---

## Decisions (locked)

1. **Agent-backend seam = generic borrow.** `@justfiles/app` exposes
   `resolveAiAccount<T>(volume, mint)`; the caller's `mint` builds the backend from a
   short-lived *lease*. Generic, so `@justfiles/app` keeps **no dependency** on
   `@justfiles/agent`/pi-ai. The lease carries `providerId` because **multiple `ai`
   providers is a target product feature** — the caller branches on it.
2. **Encryption deferred.** frieren's at-rest cred encryption is dropped. The unified
   store carries a `secretCodec` seam (default = identity/clear) so encryption returns
   as a codec swap on a single lane, not a rewrite. *Tracked regression.*
3. **No contract expansion.** The agent migrates to the **read-only** use-facets
   (`email.listUnread/readDetail/markRead`, `calendar.listToday`). The CLI commands'
   write ops (`email send`, `calendar create/delete`) are **dropped** for frieren,
   re-added later behind expanded contracts if wanted.

---

## Target architecture (end state)

```
@justfiles/app/capabilities/accounts/
  store.ts      volumeAccountsStore(volume, { secretCodec? })   ← INTERNAL, not exported
  host.ts       accountsCapabilities(providers, volume, { firstParty }) → { ai, email, calendar, accounts }
                resolveAiAccount<T>(volume, mint)               ← the agent-backend borrow
                resolveImpl / resolveTargets / fanOut           (unchanged)
  contract.ts   app-facing types (unchanged)
  index.ts      accountsAdmin capability (unchanged)

  Exported from accounts/host: Provider, Creds, ProviderRegistry,
    accountsCapabilities, resolveAiAccount
  NOT exported:               AccountsStore, Account, volumeAccountsStore

Hosts pass only a Volume; creds never cross the package boundary.
  quay:    accountsCapabilities(providers, fs, { firstParty });  agent backend via resolveAiAccount
  frieren: accountsCapabilities(providers, vol, { firstParty }); agent reaches email/calendar via capability tools
           (keeps its own env-keyed `ai` capability — frieren's agent backend is not account-driven)
```

---

## Already done — the backend seam (spike, changes merged on this branch)

The credential seam was proven against quay without touching pi-agent-core (`Agent`
already accepts a `streamFn`). These edits are in place:

- **`packages/agent/llm.ts`** — backend module:
  `AgentBackend = { model, streamFn, completeFn, revision }`, `apiKeyBackend()` (seals
  the token in the closures), `toBackend()`. `revision` is a non-secret djb2 hash so a
  host can cache-key its runtime and rebuild on token refresh without reading the token.
- **`packages/agent/llm.agent.ts` / `llm.text.ts`** — `createAgent`/`text` accept
  `LLMConfig | AgentBackend`, both via `toBackend`. Dropped `getApiKey` —
  `streamFn`/`completeFn` are the sole auth seam.
- **`apps/quay/quayd/chatgpt.ts`** — `resolveAi` (returned the raw token) →
  **`resolveAgentBackend`** (returns a token-sealed `AgentBackend`).
- **`apps/quay/quayd/agent.ts`** — `llmConfig` returns an `AgentBackend`; runtime cache
  keyed on `revision`.

> ⚠️ The spike's `resolveAgentBackend` still reads `host.accounts` (the `AccountsStore`)
> directly. **Phase 2.2 repoints it at `resolveAiAccount`** once the store is internal.

Verified: `pnpm typecheck` clean · 98 tests pass (agent + frieren + app accounts) ·
`lint:fix` applied.

---

## Phases

Shape: **expand → migrate quay → migrate frieren → contract.** Phase 1 is purely
additive (old surface stays); every deletion lands in Phase 4 so each phase ships green.

### Phase 1 — `@justfiles/app` infra (additive; nothing switches yet)

- **1.1 — Canonical volume store, internal.** Move quay's `volumeAccountsStore` into
  `capabilities/accounts/store.ts`. Add a `secretCodec` seam:
  `{ encode(creds): unknown; decode(raw): creds }`, default identity (clear). The `creds`
  field becomes the single encryptable lane (decision #2). Move quay's store unit tests
  here. *Not* re-exported via `package.json`.
  *Verify:* store unit tests pass (`pnpm test capabilities/accounts`).
- **1.2 — Agent-backend borrow seam.** Add `resolveAiAccount<T>(volume, mint)` to
  `host.ts` (see signature below). Builds the internal store, finds the first
  `ai`-enabled account, hands the caller a lease, returns `mint`'s result or `null`.
  *Verify:* unit test on a memory Volume — returns `null` when no ai account; returns the
  mint result; `persist` round-trips rotated creds.
- **1.3 — Consolidated capability factory.** Add
  `accountsCapabilities(providers, volume, { firstParty }) → { ai, email, calendar, accounts }`,
  building the store once internally. Keep the old `emailHost(providers, accounts)` etc.
  exports in parallel.
  *Verify:* adapt `host.test.ts` to drive via a Volume; old + new both green.

### Phase 2 — migrate quay

- **2.1 — Volume store via the factory.** quay → `accountsCapabilities(providers, fs, { firstParty })`.
  **Delete `apps/quay/quayd/accounts.ts`.** Drop `Host.accounts: AccountsStore` (keep
  `Host.fs`).
  *Verify:* quay tests; Settings connect/list/toggle/disconnect works against a Volume.
- **2.2 — Finalize the agent backend on the borrow seam.** Repoint
  `resolveAgentBackend` (chatgpt.ts) at `resolveAiAccount(fs, mint)`; the mint refreshes
  near-expiry via `persist` and seals the token with `apiKeyBackend`. quay now holds no
  store and no creds outside the mint closure.
  *Verify:* spike tests adapted; agent runs on connected ChatGPT; local LM Studio fallback
  intact; token-refresh writeback round-trips.

### Phase 3 — migrate frieren (the big one)

frieren's agent backend stays env-keyed (`getBackendConfig`); its `ai` capability stays
its own worker LLM (`ai.capability.ts`). This phase is **accounts storage + email/calendar
for the agent**.

- **3.1 — Agent→capability bridge.** Add generic agent tools (`email`, `calendar`) that
  invoke the kernel's `email`/`calendar` capabilities (multi-account fan-out is already
  built into the use-facet hosts). Wire into frieren's agent toolset *alongside* the
  existing CLI commands. Read-only surface only (decision #3).
  *Verify:* agent lists unread mail / reads a message / lists today's events via the new
  tools, end-to-end, with CLI commands still present.
- **3.2 — Cut over storage + delete the creds path.** frieren →
  `accountsCapabilities(providers, vol, { firstParty })`. **Delete**
  `apps/frieren/worker/accounts/store.ts` (KV) + its accounts crypto use,
  `accounts/commands.ts` (`activatingStore` + `CommandActivator`), the per-account CLI
  commands, and `CommandFactories` in `accounts/providers.ts` (keep the provider
  `registry`). Accounts now ride the Volume in the clear (encryption deferred via 1.1).
  ⚠️ **Re-home audit + rate-limit:** they currently wrap the CLI commands
  (`CommandActivator.wrap`). Either move them to the capability boundary or explicitly
  accept their loss for the dropped write path — do not drop silently.
  *Verify:* connect Fastmail/iCloud in Settings → agent reaches email/calendar via the new
  tools → an app's `email.listUnread` returns mail; `verify:ui`.

### Phase 4 — cleanup (contract)

- **4.1 — Remove the old surface.** Delete the `(providers, accounts)` host signatures
  (`emailHost`/`calendarHost`/`aiHost`/`accountsAdminHost`). Stop exporting
  `AccountsStore` and `Account` from `accounts/host` (keep `Provider`, `Creds`,
  `ProviderRegistry`, `accountsCapabilities`, `resolveAiAccount`).
  *Verify:* repo typecheck; `grep -rn AccountsStore` shows zero importers.
- **4.2 — Dead-code sweep + docs.** Remove orphaned frieren integrations crypto/audit/
  rate-limit (or finish re-homing per 3.2). Mark the `ACCOUNTS-PLAN.md` residual
  ("Agent commands vs capability calls") as done.
  *Verify:* full `pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test`.

---

## Key signatures

```ts
// packages/app/capabilities/accounts/store.ts — INTERNAL (not re-exported)
export interface SecretCodec {
	encode(creds: Creds): unknown // default: identity (clear)
	decode(raw: unknown): Creds
}
export function volumeAccountsStore(volume: Volume, opts?: { secretCodec?: SecretCodec }): AccountsStore

// packages/app/capabilities/accounts/host.ts

// A short-lived borrow of the ai-enabled account, for building the agent's own
// runtime. `creds` never leave this closure; `persist` is the only writeback (the
// store stays internal). `providerId` lets the caller branch across ai providers.
export interface AiAccountLease {
	creds: Creds
	config: unknown          // account.enabled.ai (e.g. { model })
	providerId: string
	persist(creds: Creds): Promise<void> // write rotated creds back (token refresh)
}

export async function resolveAiAccount<T>(
	volume: Volume,
	mint: (lease: AiAccountLease) => T | Promise<T>
): Promise<T | null> // null when no ai-enabled account, or when mint returns null

// One factory, store built once internally. Hosts wire the subset they need
// (frieren keeps its own env-keyed `ai`).
export function accountsCapabilities(
	providers: ProviderRegistry,
	volume: Volume,
	opts?: { firstParty?: Iterable<string> }
): { ai: Capability; email: Capability; calendar: Capability; accounts: Capability }
```

quay's caller (Phase 2.2), showing the token sealed into the backend:

```ts
// apps/quay/quayd/chatgpt.ts
export function resolveAgentBackend(fs: Volume): Promise<AgentBackend | null> {
	return resolveAiAccount(fs, async ({ creds, config, providerId, persist }) => {
		// providerId === 'chatgpt' today; branch here when more ai providers land
		let c = creds as ChatgptCreds
		if (c.expires - Date.now() < 60_000) {
			try {
				const r = await refreshOpenAICodexToken(c.refresh)
				c = { access: r.access, refresh: r.refresh, expires: r.expires, accountId: String(r.accountId ?? c.accountId) }
				await persist(c) // rotated refresh token persisted for the next host to sync
			} catch {
				/* keep stale token; request 401s → re-auth */
			}
		}
		const model = resolveModel((config as { model?: string })?.model) ?? resolveModel(undefined)
		return model ? apiKeyBackend({ model: model as AgentBackend['model'], apiKey: c.access }) : null
	})
}
```

---

## Risks / follow-ups

- **Plaintext creds on the Volume (decision #2).** frieren's at-rest encryption is gone
  until a `secretCodec` is supplied. Re-introduce by passing an encrypting codec to
  `volumeAccountsStore` — no store-logic change. Track as a security follow-up.
  **Update (#290/#291):** the lane moved from `/system/accounts` to the host-private
  `/host/accounts`, which never replicates in either direction, so the bytes no longer
  reach a client at all. Encryption at rest is #292 (this same codec seam).
- **Dropped write ops (decision #3).** Agent loses `email send` / `calendar create/delete`
  in frieren. Re-add by expanding the `email`/`calendar` contracts + provider mints
  (a future slice); revisit whether writes are admin/first-party-gated then.
- **Audit + rate-limit (3.2).** Must be re-homed at the capability boundary or explicitly
  dropped — don't let them vanish with the CLI commands.
- **Multi-`ai`-provider branching.** `resolveAiAccount` returns the first ai-enabled
  account; the mint branches on `providerId`. When a second `ai` provider ships, decide
  selection policy (first-enabled vs. an explicit "active backend" pick in Settings).
```

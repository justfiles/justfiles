_packages/app-settings · design_

# Settings — one connection store, two hosts

`app-settings` is a built-in (now seeded in **frieren** _and_ **quay**) for wiring up the
host: AI auth, email, calendar, anything that needs a credential. Today it is a thin
façade over the `integrations` capability, and that capability only knows **static
credential forms** stored in **frieren's** Durable-Object KV. This redesign makes Settings
**host-portable** and adds the two things v1 needs — **Sign in with ChatGPT** (URL-redirect
OAuth) and **Fastmail email** — so both work in both hosts.

- Research + design only — no code in this document. The only code change so far is seeding
  `@justfiles/app-settings` into quay's built-in catalog (`apps/quay/quayd/builtins.ts`).
- Reuses the `integrations` registry, capability, and Fastmail provider already in frieren.
- Cross-refs: `apps/quay/DESIGN.md` · `apps/frieren/worker/integrations/*` ·
  `packages/app/capabilities/integrations/*` · `packages/app/capabilities/ai/*`.

**Contents**

1. [The one principle](#principle)
2. [The connection record is a Volume file](#volume)
3. [The shared registry: providers are code, connections are files](#registry)
4. [The capability surface (kept stingy)](#capability)
5. [Provider A — Fastmail (static)](#fastmail)
6. [Provider B — Sign in with ChatGPT (OAuth/PKCE)](#chatgpt)
7. [The one host-specific seam: the redirect catcher](#broker)
8. [AI backend resolved from the Volume](#ai)
9. [Why "do it in one, have it in both" falls out for free](#both)
10. [The Settings UI redesign](#ui)
11. [Reused vs. new](#reuse)
12. [Open questions](#open)

<a id="principle"></a>

## 1 · The one principle

> **A connection is a file on the Volume.** Provider *definitions* are code in a shared
> package; *connections* (who's signed in, with what token) are JSON files in the Volume.
> The host reads those files to activate commands and to resolve the AI backend.

Everything else follows. The Volume is the substrate both hosts already share
(`fsStore` in quay today, frieren's synced backend later — same `@justfiles/fs`
`volume`). Put the credential there and the question "how do I do this in *both* frieren and
quay" mostly dissolves: the record syncs, and **using** a token never needs a browser.

The only thing that is genuinely host-specific is **acquiring** an OAuth token — because that
needs to open a browser and catch a redirect, which a synced DO and a native daemon do
differently. §7 isolates exactly that, and §9 shows why the *second* host never has to repeat
it.

<a id="volume"></a>

## 2 · The connection record is a Volume file

One file per connected account, under the agent-owned `/system` tree (same place quay seeds
`soul.md`):

```
/system/connections/<providerId>/<accountId>.json
```

```jsonc
// /system/connections/chatgpt/default.json
{
  "providerId": "chatgpt",
  "accountId":  "default",
  "kind":       "oauth",                 // "static" | "oauth"
  "oauth": {
    "accessToken":  "…",
    "refreshToken": "…",
    "expiresAt":    1760000000000,
    "accountId":    "<chatgpt-account-id>"   // from the id_token, used as a request header
  },
  "enabledAt": 1759990000000,
  "lastError": null
}
```

```jsonc
// /system/connections/fastmail/default.json
{ "providerId": "fastmail", "accountId": "default",
  "kind": "static", "static": { "token": "fmu1-…" }, "enabledAt": 1759990000000 }
```

This is the exact shape of frieren's existing `CredentialRecord` (`storage.ts`) — `static` |
`oauth` — just relocated from DO-KV onto the Volume. Frieren's `ConnectionStore` already
abstracts its backend behind a tiny `KvStorage` (`get/put/delete/list({prefix})`); a
**Volume-backed `KvStorage`** (one file per key under `/system/connections/`) is the whole
port. No registry change.

**At rest.** Frieren encrypts the record before it hits KV (`crypto.ts` + `INTEGRATION_KEY`).
On the Volume the same envelope can ride along — store the ciphertext as the file body, keep a
small plaintext header (`providerId`, `accountId`, `kind`, `lastError`) so the list view and a
human opening Files can see *what* is connected without seeing the secret. Whether to encrypt
in v1 is an open question (§12); the layout is the same either way.

<a id="registry"></a>

## 3 · The shared registry: providers are code, connections are files

Frieren's `Integrations` registry (`worker/integrations/registry.ts`) is already the right
object: `define(provider)`, `connect`, `disconnect`, `hydrate`, `list`. It has **no Cloudflare
dependency** — its only injected seams are a `CommandRegistry`, a `ConnectionStore`, and
optional audit/rate-limit. So:

- **Lift the registry + the providers into a shared package** (e.g. `@justfiles/app/integrations`
  or a sibling), parameterised by the `ConnectionStore` (now Volume-backed) and the host's
  `CommandRegistry`. Frieren keeps using it unchanged; **quayd mounts the same registry**.
- **Provider definitions stay code** — `fastmailIntegration()`, a new `chatgptIntegration()`,
  `icloudCalendarIntegration()` — because a provider is *behaviour* (schema + how to mint bash
  commands + how to OAuth), not data. They live next to the registry, shared by both hosts.
- **`hydrate()` on boot** reads `/system/connections/*` off the Volume and re-activates each
  provider's commands. This is what makes a Fastmail token signed-in on one host light up the
  `email`/JMAP bash commands on the other after a sync — frieren already does exactly this from
  KV; we only changed where the bytes are.

Mounting in quayd is then a three-line addition to `createHost` (§7 of quay's DESIGN already
reserves the capability registry for this): construct a Volume `ConnectionStore`, build
`Integrations`, `register: { integrations: integrationsCapability(registry) }`. That is what
makes the Settings app I just seeded into quay's catalog actually *function* — today it would
list nothing because quayd registers no `integrations` capability.

<a id="capability"></a>

## 4 · The capability surface (kept stingy)

The app-facing `integrations` contract today is `list / connect / disconnect`, and `connect`
assumes a **static form**. OAuth needs a redirect, which the untrusted reducer/webview can't
drive (it can't bind a loopback port or open the system browser). So acquisition moves
**host-side**, and the capability gains exactly **one** method — `begin` — returning a
discriminated union the UI renders against:

```ts
interface IntegrationsCapability {
  list(input: {}): Promise<IntegrationDescriptor[]>          // descriptor gains authKind
  begin(input: { id: string; accountId: string }): Promise<BeginResult>
  disconnect(input: { id: string; accountId: string }): Promise<void>
}

type BeginResult =
  | { kind: 'form';   schema: IntegrationCredentialsSchema }  // static → render the form
  | { kind: 'redirect' }                                      // OAuth → host opened the browser
  | { kind: 'device'; verificationUrl: string; userCode: string }   // OAuth, no loopback
```

- For a **static** provider, `begin` returns the form schema (today's behaviour); the UI
  collects fields and the host writes the record. (`connect` can stay as the form-submit verb,
  or fold into `begin` + a follow-up — implementation detail; the surface stays three verbs.)
- For an **OAuth** provider, `begin` makes the host **start the flow** (§7): open the browser
  (loopback) or hand back a device code. The UI shows "waiting…", then sees the new account
  appear via the **existing** `list`/subscribe path — no new completion channel. The host wrote
  the Volume file; `list` reflects it.

`IntegrationDescriptor` gains one field, `authKind: 'static' | 'oauth'`, so the card knows
whether to draw a form or a **Sign in** button. That is the entire contract delta.

<a id="fastmail"></a>

## 5 · Provider A — Fastmail (static)

The easy half, already built. `fastmailIntegration()` exists (`worker/integrations/fastmail`):
schema is a single `token` (Fastmail → Settings → Privacy & Security → **API token**, not an
app password); `commands()` builds a JMAP client and registers the `email`/Fastmail bash
command. Nothing about it is frieren-specific.

Redesigned flow: Settings shows a Fastmail card → `authKind: 'static'` → token field → submit
→ host writes `/system/connections/fastmail/default.json` → `hydrate`/activate registers the
JMAP commands. In quay those commands are now available to the in-daemon agent and to any app
holding the `email` capability; in frieren, identically. Multiple accounts = multiple
`<accountId>.json` files; "multiple providers" = more definitions (Gmail next) with no surface
change. **For v1, ship Fastmail only.**

<a id="chatgpt"></a>

## 6 · Provider B — Sign in with ChatGPT (OAuth/PKCE)

The goal: drive the agent off the user's **ChatGPT Plus** subscription, via the URL-redirect
flow — the same one Codex's `Sign in with ChatGPT` uses. It is standard **OAuth 2.0 + PKCE
(S256)** against OpenAI's public Codex client:

| Field | Value |
|----|----|
| client_id | `app_EMoamEEZ73f0CkXaXp7hrann` (OpenAI's public Codex client) |
| authorize | `https://auth.openai.com/oauth/authorize` |
| token | `https://auth.openai.com/oauth/token` |
| redirect (loopback) | `http://localhost:1455/auth/callback` |
| scope | `openid profile email offline_access` (`offline_access` ⟹ refresh token) |
| PKCE | S256 — random `code_verifier`, `code_challenge = base64url(sha256(verifier))` |

Flow (loopback variant):

1. Host generates `code_verifier`/`code_challenge` + `state`, binds a one-shot listener on
   `127.0.0.1:1455`, opens the system browser to `…/authorize?response_type=code&client_id=…&
   redirect_uri=http://localhost:1455/auth/callback&scope=…&code_challenge=…&code_challenge_method=S256&state=…`.
2. User approves in ChatGPT; the browser hits the loopback `…/auth/callback?code=…&state=…`.
3. Host POSTs `grant_type=authorization_code` + `code` + `code_verifier` + `client_id` to the
   token endpoint → `{ access_token, refresh_token, id_token }`. The **ChatGPT account id** is a
   claim inside `id_token` (used later as a request header).
4. Host writes `/system/connections/chatgpt/default.json` (§2).

**Using the token** (this is what makes it the AI backend, §8): model calls go to base
`https://chatgpt.com/backend-api/codex` with `Authorization: Bearer <access_token>` and a
`chatgpt-account-id: <account_id>` header — an OpenAI-compatible surface, so it slots straight
into the agent's existing `openai-completions` config.

**Refresh** is a plain POST `grant_type=refresh_token` to the token endpoint — **no browser, no
loopback** — done proactively before `expiresAt` and reactively on `401`. This is the key
asymmetry exploited in §9: *acquiring* needs a redirect; *refreshing* and *using* never do.

> Caveats worth stating plainly: this rides OpenAI's **public Codex client and its private
> `backend-api/codex` surface** — unofficial, undocumented, and subject to change or ToS limits.
> v1 treats it as best-effort with a clean fallback to an API-key field (a second `authKind:
> 'static'` mode) and the local LM-Studio default both hosts already ship.

<a id="broker"></a>

## 7 · The one host-specific seam: the redirect catcher

Acquiring an OAuth token is the **only** part that differs per host. Isolate it behind a small
port the provider definition is handed; everything else (PKCE math, token parsing, refresh,
writing the Volume file) is shared code:

```ts
interface OAuthBroker {
  // Acquire — host-specific. Returns the token set the registry persists.
  authorize(p: OAuthProviderConfig): Promise<OAuthTokens>
  // Refresh & use — shared (plain POSTs); lives in the registry, not the broker.
}
```

- **quay** implements `authorize` with the **loopback** flow above: bind `127.0.0.1:1455`,
  `open` the URL (the native shell already shells out to `open` for app bundles — DESIGN §8),
  resolve on the callback. This is a near-verbatim port of Codex and gives the best UX. The
  daemon already owns localhost, so there is nothing new to stand up.
- **frieren** has no loopback. Two portable options, in preference order:
  1. **Don't acquire in frieren at all** — rely on §9: sign in once in quay, the synced Volume
     file carries the token + refresh, frieren just *uses* and *refreshes* it. Zero new
     frieren code. This is the recommended v1.
  2. If frieren must initiate, use the **device-code** flow (`grant_type` device authorization):
     show `verificationUrl` + `userCode`, user approves on any device, frieren polls the token
     endpoint. No loopback, works in a browser tab. (Requires the ChatGPT account's *Allow
     device code login* toggle.) This is the `BeginResult.kind: 'device'` branch.

**Refresh is not in the broker** — it's a shared registry concern, so both hosts refresh
identically off the stored `refreshToken`. That is deliberate: the hard, host-specific step
happens once; the recurring step is universal.

<a id="ai"></a>

## 8 · AI backend resolved from the Volume

Today both hosts hardcode their model: quay's `llmConfig()` and frieren's `getBackendConfig()`
both point at local LM-Studio / an env-selected backend. Neither reads a connection. The
redesign adds **one resolution step** shared by both:

> On agent/`text` construction, read `/system/connections/chatgpt/default.json`. If present and
> valid, build the LLM config as `openai-completions` against `https://chatgpt.com/backend-api/codex`
> with the bearer + `chatgpt-account-id` header, wrapped so a `401` triggers a refresh-and-retry.
> Otherwise fall back to the existing local/default backend.

Because the agent runs **in the host** (quayd's daemon, frieren's DO — never in a webview), the
token never touches untrusted code. The reducer-facing `ai` capability (`generateText`) resolves
the same way, so an app that calls `ai` and the chat agent share one credential. Result: "set up
AI auth in Settings" changes the model both the agent and apps use, in whichever host reads that
file — which, once synced, is both.

<a id="both"></a>

## 9 · Why "do it in one, have it in both" falls out for free

Pulling §2–§8 together, the matrix the user asked for:

| | acquire | use | refresh |
|----|----|----|----|
| **Fastmail** | static form — works in **both** hosts as-is | both | n/a |
| **ChatGPT** | redirect — **loopback in quay**, device-code in frieren | both (Volume file) | both (plain POST) |

The trick is that **use** and **refresh** are host-agnostic (just HTTP with a stored secret),
and the secret is a **synced Volume file**. So:

- **Fastmail**: a static token entered in *either* host writes the same Volume file; the other
  host's `hydrate` lights up the JMAP commands. Symmetric, trivial.
- **ChatGPT**: sign in *once* where the redirect is easy (quay's loopback). The token + refresh
  land on the Volume; frieren never opens a browser — it reads the file, uses the bearer, and
  refreshes off the refresh-token. The redirect, the one asymmetric step, is needed exactly
  once per account, not once per host.

This is the concrete payoff of "everything is a file on our Volume": the credential is data,
data syncs, and only the *acquisition ritual* is platform-bound — and even that is paid once.

<a id="ui"></a>

## 10 · The Settings UI redesign

The current GUI renders one card per descriptor with a static field form. Minimal changes:

- **Branch on `authKind`.** `static` → today's field form (Fastmail's `token`). `oauth` → a
  **Sign in** button that calls `begin`; on `kind:'redirect'` show "Complete sign-in in your
  browser…", on `kind:'device'` show the code + URL. Either way, completion arrives through the
  existing `list`/subscribe refresh — the card flips to a connected row when the Volume file
  appears. No new state channel; the reducer already reloads `items` after a mutation.
- **Group by purpose** rather than a flat list — *AI*, *Email*, *Calendar* — so v1 reads as
  "set up your AI" and "set up your email", which is the user's mental model. Cosmetic; the data
  is still the descriptor list.
- **Multi-account** stays as today's `accountId` field (one row per connected account), so
  "multiple providers" and "multiple accounts" need no surface change — just more provider
  definitions and more `<accountId>.json` files.

The app stays a **thin façade** — all behaviour is in the shared registry + host broker; the GUI
only renders descriptors and forwards intents, exactly the trust posture quay's DESIGN §7 wants.

<a id="reuse"></a>

## 11 · Reused vs. new

**Reused (no rewrite):** the `Integrations` registry, `ConnectionStore`/`CredentialRecord`,
`crypto.ts`, the `integrations` capability + `integrationsCapability` adapter, and
`fastmailIntegration()` — all already host-agnostic in frieren's worker.

**New (small):**
- A **Volume-backed `KvStorage`** (one file per key under `/system/connections/`) — the only
  storage port.
- **Lift** registry + providers into a shared package both hosts import.
- **`chatgptIntegration()`** + a shared **PKCE/token/refresh** helper (the OAuth math).
- The **`OAuthBroker.authorize`** seam: quay's loopback implementation (`open` + `127.0.0.1:1455`);
  frieren's optional device-code path.
- **AI resolution from the Volume** in quay's `llmConfig()` and frieren's `getBackendConfig()`.
- Capability delta: `begin` + `BeginResult`, descriptor `authKind`; UI branches on it.
- Wire the `integrations` capability into `quayd` `createHost` (makes the seeded Settings app live).

<a id="open"></a>

## 12 · Open questions

- **At-rest encryption on the Volume.** Frieren encrypts in KV with `INTEGRATION_KEY`. The
  Volume is the user's own (synced) store, but a token is more sensitive than a note. Reuse the
  envelope with a host-held key (Keychain on macOS), or accept plaintext-in-Volume for v1?
- **ChatGPT client legitimacy.** Riding OpenAI's public Codex client + `backend-api/codex` is
  unofficial and may break or violate ToS. Keep the API-key + local fallbacks first-class.
- **Device-code opt-in.** frieren's device path needs the account's *Allow device code login*
  toggle; otherwise frieren is use-only (recommended anyway, §9).
- **Loopback port conflicts.** `1455` may be taken (another Codex/quay). Range-scan and pass the
  chosen port in `redirect_uri`, as Codex does.
- **Refresh races.** Two hosts holding the same refresh-token could both refresh and one
  invalidate the other. Single-writer per host is fine; cross-host needs a last-writer-wins on
  the Volume file (good enough) or a refresh lease (later).
- **Token expiry vs. sync latency.** A freshly-refreshed token on host A reaches host B only on
  next sync; B's reactive `401`-refresh covers the gap. Confirm the refresh-token isn't rotated
  in a way that strands B.

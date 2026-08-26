---
project: platform/runner, platform/frieren, apps/settings
status: todo
---

# Runner: use a Frieren platform token

## Result

A Frieren user can connect the `justapps.run` platform once. Runner can then give each hosted
app only the Frieren capabilities that all four checks allow:

```text
Frieren platform token capabilities
  ∩ the app's signed capability manifest
  ∩ the user's Runner grant for that app
  ∩ Runner's fixed policy
```

Frieren owns the user, platform token, capability switches, volume, and AI budget. Runner owns
the per-app prompt and grant. Runner-hosted app code never receives the platform token.

Clerk remains Frieren's sign-in system. Runner does not use Clerk, expose a Clerk consent flow,
or hold Clerk tokens.

## Product boundary

Frieren and `justapps.run` are separate platforms.

- Frieren issues one revocable token for the `justapps.run` platform.
- The token has platform-wide `volume` and `ai` switches. It has no app IDs.
- Runner seals the token on its backend and shares it across approved apps.
- Runner checks and prompts for each app separately.
- Turning a switch off in Frieren stops that capability for all Runner apps.
- Turning a switch on does not grant it to an app. The app still needs its Runner grant.

This design makes `justapps.run` a trusted Frieren client. Frieren trusts Runner to keep apps
inside their grants. A Runner backend compromise can use every capability enabled for the
platform token. We accept this because `justapps.run` is trusted.

## Current main

Main has finished the old plan through the online volume step:

- the app GUI runs in an opaque iframe;
- Runner stores sealed Clerk OAuth credentials and app grants in D1;
- Runner has Clerk OAuth routes, root and app sessions, and one-use tickets;
- Frieren accepts the Runner Clerk OAuth clients; and
- a connected app can use its Frieren volume through the Runner Store proxy.

The browser isolation and Store proxy are useful. The Clerk connection is not.

Keep:

- the opaque app iframe and `MessagePort` host API;
- the signed capability manifest and stable capability hash;
- per-app grants, app sessions, request nonces, and one-use app tickets;
- the Store route and method allowlist;
- the online `httpStore()` volume and app chroot;
- the signed-out IndexedDB volume and offline behavior; and
- token sealing with a versioned Runner secret.

Delete:

- Clerk OAuth applications for Runner;
- OAuth discovery, PKCE, state, nonce, callback, and refresh code;
- sealed Clerk access and refresh tokens;
- refresh leases and token rotation code;
- the `oauth_flows` table;
- Runner Clerk issuer, client ID, and client secret settings;
- Runner client IDs in Frieren's Clerk allowlist; and
- the `jose` dependency from Runner.

Do not preserve the experimental OAuth connections. The migration can delete their rows and
require test users to paste a Frieren platform token.

## Frieren platform token

### Token shape

Use a compact versioned token signed by a Frieren Worker secret. Its signed payload contains:

- the Frieren user ID;
- the fixed platform ID `justapps.run`;
- a random 256-bit token ID; and
- the token format version.

Do not put capabilities in the signed payload. Store the current capability switches in the
user's Frieren Durable Object so a toggle or revoke takes effect on the next request.

Store only a hash of the token ID in Frieren. Show the complete token once, when the user creates
or rotates it. Use a separate versioned signing secret such as `PLATFORM_TOKEN_KEY_V1`.

Allow one active `justapps.run` token for each Frieren user in the first version. Rotation
invalidates the old token. Do not add token labels, multiple platform tokens, expiry choices, or
usage limits in this task.

### Frieren state

Add one small table to the existing per-user Frieren Durable Object:

```sql
CREATE TABLE platform_tokens (
	platform TEXT PRIMARY KEY,
	id_hash TEXT NOT NULL,
	capabilities TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
```

`capabilities` is a sorted JSON array containing only `volume` and `ai`.

Rotation replaces the row with a new token ID. Revocation deletes the row.

The signed token gives the Worker the user ID needed to select the Durable Object. The Durable
Object then checks the token ID row and its current switches. Do not add D1, KV, or a second user
store to Frieren.

### Frieren routes

Keep the management API behind the user's normal Frieren session:

- `GET /api/platforms` lists the platform, switches, and creation date. It never returns the token.
- `POST /api/platforms/justapps.run/token` creates or rotates the token and returns it once.
- `PATCH /api/platforms/justapps.run` sets the `volume` and `ai` switches.
- `DELETE /api/platforms/justapps.run` revokes the token.

Add one route for Runner:

- `GET /api/platform/v1/account` accepts the platform token and returns the Frieren user ID and
  current capability switches.

The existing resource routes also accept the platform token:

- `/store/*` requires the platform `volume` switch;
- `/api/ai/*` requires the platform `ai` switch; and
- all other Frieren routes reject the platform token.

Session and Mac OAuth tokens keep their current behavior. Runner platform tokens do not pass
through Clerk middleware and do not change the Mac OAuth flow.

## Runner connection

The user pastes the platform token once on the Runner root host.

```text
<app>.justapps.run
  -> https://justapps.run/connect?app=<canonical app id>
  -> paste the token created in Frieren
  -> Runner checks GET <Frieren>/api/platform/v1/account
  -> Runner seals the token and creates a root session
  -> Runner shows the app capability prompt
  -> one-use ticket
  -> https://<app>.justapps.run/_runner/connect/callback?ticket=<ticket>
  -> host-only app cookie
  -> app opens with approved capabilities
```

The connect page must link to Frieren's Connected Platforms settings. It must not load Clerk or
redirect to an auth provider.

Use an exact `Origin` check, form content-type check, `frame-ancestors 'none'`, and a form token
where a session exists. The consent page must use `Referrer-Policy: same-origin` so a browser form
sends the origin that Runner checks.

### Runner state

Replace the experimental OAuth schema instead of adapting its columns:

```sql
CREATE TABLE accounts (
	user_id TEXT PRIMARY KEY,
	platform_token TEXT NOT NULL
);
```

`platform_token` is sealed with `TOKEN_SEAL_KEY_V1`. The migration drops all four experimental
auth tables, then recreates `accounts`, `app_grants`, and `sessions`. Keep the current grant and
session shapes, including root, app, and ticket sessions. Do not keep `oauth_flows` or any
refresh field.

The platform token stays only in the `accounts` row and Runner Worker memory during an upstream
request. It must not appear in HTML, cookies, URLs, logs, app messages, or browser storage.

### App grants

Runner maps signed app capabilities to resources as it does now:

- normal `volume` maps to `volume:app`;
- only `justfiles.files` can request `volume:system`;
- `ai` maps to `ai`; and
- unknown Frieren resource mappings and forbidden scopes fail closed.

Before Runner creates a grant or reports an app as connected, it checks the current Frieren
platform switches. An app cannot connect if its required resource is off in Frieren. Runner
shows a link to the Frieren switch instead of silently granting a smaller set. Frieren checks
the switch again on every Store or AI request.

Runner remains the per-app security boundary. Frieren does not know app IDs. The Store proxy
keeps the app chroot, and the AI proxy keeps the app grant check.

## Work plan

Each step must be a small change that can merge and deploy on its own.

### 1. Add platform tokens to Frieren

Add the signed token format, the Durable Object table, management routes, token validation, and
the `volume` and `ai` route checks.

Keep Clerk session and Mac OAuth handling unchanged. Add unit tests for create, rotate, toggle,
revoke, wrong signature, wrong platform, and forbidden route access.

Done when a test user can create a token through the API and use it only on resources enabled in
the Durable Object row.

### 2. Add the Frieren settings control

Add one small Connected Platforms section to Frieren Settings. It shows `justapps.run`, the two
switches, the creation time, and create, copy, rotate, and revoke actions.

Show the raw token only in the response to create or rotate. Use the existing trusted Settings
host so the Settings app never receives a Clerk session token. Drop the raw platform token from
UI state when the user leaves the result.

Done when a signed-in user can manage the token without a dashboard or CLI.

### 3. Replace Runner OAuth with token paste

Start from current main. In one delete-first Runner change:

1. Add a migration that drops the four experimental auth tables and recreates only accounts,
   app grants, and sessions.
2. Replace the Clerk redirect and callback with the token form and Frieren account check.
3. Seal the platform token and create the existing root session.
4. Keep the app consent, grant, ticket, app cookie, Store proxy, and online volume.
5. Replace OAuth refresh with a direct read of the sealed platform token.
6. Delete OAuth and refresh modules and tests.
7. Remove Clerk settings and `jose` from Runner.
8. Fix the consent page referrer policy.

Make local work use staging without extra shell flags:

```json
{
	"predev": "wrangler d1 migrations apply runner-auth --local --env dev",
	"dev": "CLOUDFLARE_ENV=dev vite dev"
}
```

After the one-time `.dev.vars` setup for `GITHUB_TOKEN` and `TOKEN_SEAL_KEY_V1`, this must work:

```sh
cd platform/runner
pnpm dev
```

There is no fixed OAuth callback port and no local Frieren process. Runner uses the staging
`FRIEREN_ORIGIN` from `env.dev`.

Done when the existing Draw online-volume smoke test passes with a pasted staging platform token.

### 4. Remove Runner from Clerk OAuth

After Runner no longer sends Clerk tokens, remove the two Runner client IDs and their cases from
Frieren's OAuth allowlist tests. Keep the Mac client IDs.

Delete the Runner OAuth applications from Clerk only after production no longer uses them. This
is an operations cleanup, not a code dependency for step 3.

### 5. Add Runner AI

Add the trusted Runner AI proxy and host capability. Require all of these before a request:

- the platform token has `ai` enabled in Frieren;
- the current signed app manifest declares `ai`;
- the user granted `ai` to that app;
- the app session and request nonce are valid; and
- the request matches the fixed Frieren AI route and request shape.

Frieren charges the request to the user resolved from the platform token. Runner does not keep a
second quota.

Done when an approved app can use AI, an unapproved app cannot, and Frieren records the usage for
the correct user.

### 6. Finish connection controls

Add the small shelf and settings actions needed to use the finished flow:

- connect the platform;
- approve or disconnect one app;
- disconnect the platform and delete all its Runner grants and sessions;
- show when a Frieren platform switch blocks a capability; and
- keep signed-out local data separate from connected Frieren data.

Do not add account profiles, avatars, emails, token labels, audit dashboards, or local-to-Frieren
data migration.

## Security rules

- Runner-hosted app code never gets the platform token, app cookie, or request nonce.
- Keep the GUI in its opaque iframe and the reducer in its Worker.
- Keep the token sealed at rest in Runner.
- Keep root and app cookies host-only. Do not use a `.justapps.run` domain cookie.
- Recheck the signed manifest and stored app grant on every Store or AI call.
- Treat Frieren's current platform switches as the upper limit.
- Let Frieren reject a revoked token or disabled capability on the next request.
- Do not switch to local data after a temporary network or token error.
- Do not expose `/private` through the platform token.
- Keep `volume.watch` unavailable over the online Store until one shared push channel exists.

## Tests

Keep focused tests for these boundaries:

- token signature, platform ID, token ID hash, rotate, toggle, and revoke;
- platform tokens reach only Store, AI, and the account check route;
- a disabled Frieren switch stops all Runner apps that use that resource;
- enabling a Frieren switch does not create an app grant;
- invalid pasted tokens do not create Runner accounts or sessions;
- Runner stores only the sealed token;
- app A cannot use app B's grant, session, ticket, volume path, or nonce;
- a manifest capability increase needs a new app grant;
- normal apps get only their app volume;
- only `justfiles.files` can receive system volume access;
- signed-out apps keep their IndexedDB data and offline behavior;
- connected Store and AI failures do not fall back to local data; and
- `pnpm dev` in `platform/runner` selects staging, applies local migrations, and needs no callback port.

Run the repository checks after each code change:

```sh
pnpm run format
pnpm run typecheck
pnpm run lint:fix
pnpm run test
```

Before rollout, run one browser smoke test for token creation, token paste, app consent, online
volume read and write, AI use, a Frieren capability toggle, app disconnect, and platform revoke.

## Rollout

1. Deploy Frieren token support with no token created.
2. Deploy the Frieren settings control and create one staging token.
3. Deploy the Runner pivot to staging. Its migration deletes staging OAuth connections.
4. Test Draw volume access, capability toggles, disconnect, reconnect, and token rotation.
5. Deploy Runner production and require users to paste a platform token.
6. Remove the Runner Clerk client IDs and OAuth applications.
7. Add AI only after the platform-token volume path is stable.

Frieren and Runner still deploy separately. Their stable contract is the Frieren platform token
and the existing Store and AI HTTP routes.

## Done when

- A user creates one `justapps.run` token in Frieren and pastes it once into Runner.
- All approved Runner apps use that one sealed backend token.
- Frieren switches set the platform-wide upper limit.
- Runner prompts and enforces each app grant.
- Normal apps can reach only their own volume path.
- AI uses the same Frieren user and budget.
- Clerk has no Runner client or callback configuration.
- Signed-out apps still work offline with their old local data.
- `pnpm dev` under `platform/runner` connects to staging without a local Frieren process.

## Not in this task

- per-app Frieren tokens;
- OAuth, PKCE, or automatic browser pairing;
- multiple `justapps.run` tokens for one Frieren user;
- token labels, custom expiry, or per-token quotas;
- a shared cookie across app subdomains;
- a Frieren volume replica in Runner;
- automatic upload or merge of local app data;
- offline access to the connected Frieren volume;
- live `volume.watch` for external changes; or
- changes to Mac or desktop authentication.

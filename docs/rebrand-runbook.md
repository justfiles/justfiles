# Rebrand runbook (rename + new domain)

How to rebrand the public product again — a new name and a new domain — with minimal
downtime. Written after the Spud → Kodama rebrand, distilled to what still matters.

**A future rebrand is small.** The Spud → Kodama migration was large only because the old
public brand had leaked into the app bundle IDs (`computer.spud.* → app.justfiles.frieren.*`),
which forced a one-off per-user data migration. That is fixed permanently: the IDs and every
internal name are now brand-free. So a rebrand is now just **public copy + the domain (app +
Clerk)**. No data migration, no id rename, no migrator, no backups.

## Invariants — never change these

- **Internal names**: `frieren`, the `Frieren` Durable Object class, `frieren-staging`,
  worker names, R2 buckets, DO namespaces, source dirs, schema names.
- **App bundle IDs**: `app.justfiles.frieren.*` (permanent, brand-free). Same for the macOS
  bundle scheme.
- **Release tag component**: `frieren` → tags `frieren-v*`, which is the prod deploy trigger.
- **npm package names** (for example `@justfiles/app-code`): distribution identities, immutable
  after publication.
- **The Clerk instance itself**: same instance ⇒ same user IDs ⇒ same per-user Durable
  Objects. Only its *domain* changes.

Keeping these stable is the whole reason a rebrand stays cheap. A static test already rejects
the public brand leaking back into IDs/infra — keep it.

## What a rebrand actually changes

1. **Public copy and discovery**: `apps/frieren/index.html` `<title>`, PWA manifest, the App
   Store npm keyword and indexer user-agent, the AI provider display name
   (`packages/app/capabilities/accounts/providers/spud.ts` → `name`), onboarding / marketing /
   legal / email / social copy. (The internal id `spud` and `spudProvider` stay.)
2. **The public domain** (`mykodama.app` → `newname.tld`): a Cloudflare Custom Domain on the
   worker **and** the Clerk production instance's domain.
3. **Optionally** a new Google Cloud OAuth project (cosmetic; the existing one can be reused).

## Deploy model — know this cold

Deploys are **GitHub Actions only. Never run `wrangler deploy` by hand.**

- Merge to `main` → auto-deploys **staging** (`deploy-frieren-staging.yml`).
- **Prod** deploys on a **`frieren-v*` tag** (release-please merge → tag → `deploy-frieren-production.yml`),
  or `workflow_dispatch` with `ref=frieren-vX.Y.Z`.

⚠️ This repo uses `@cloudflare/vite-plugin`, which **bakes the wrangler environment at build
time via `CLOUDFLARE_ENV`** and deploys a generated `dist/frieren/wrangler.json`. So
`wrangler deploy --env staging` is **inert** — a manual `wrangler deploy` builds the *top-level*
(production) config and **deploys to prod**. (This is exactly how a "staging" deploy once hit
production; recover with `wrangler rollback <prev-version-id> --name frieren`.)

The client's Clerk key is `VITE_CLERK_PUBLISHABLE_KEY`, injected at build from the
**environment-scoped** GitHub secret `FRIEREN_CLERK_PUBLISHABLE_KEY` (different values in the
`staging` and `production` GitHub environments). The worker's `vars.CLERK_PUBLISHABLE_KEY` is
**not read by the worker** — vestigial; keep it non-stale but don't rely on it.

## Clerk facts — the risky part

- **Production Clerk keys are domain-locked.** `pk_live_…clerk.<domain>` only works when the
  app is served from `<domain>`. Serving on a new domain with the old key fails with
  *"Production Keys are only allowed for domain …"*.
- ⚠️ A CORS `access-control-allow-origin` reflection on `/v1/environment` is **not** proof the
  domain is accepted — it is just CORS. Do not use it to conclude "no domain change needed"
  (that mistake shipped a broken prod domain).
- Moving domains **requires** `change_domain`: it retires the old domain's auth, generates a
  **new publishable key**, and needs new DNS + SSL. The **Secret Key does not change**.
- New publishable key is deterministic: `pk_live_<base64("clerk.<newdomain>$")>` (verify in the
  Dashboard).
- `clerk deploy status` (after `clerk link --app <app>`) is the source of truth for
  dns / ssl / mail readiness.
- Prod social connections (e.g. Google) use **custom** OAuth credentials whose redirect URI is
  `https://clerk.<domain>/v1/oauth_callback`. A domain move changes that URI — update it in the
  provider console, or Google sign-in breaks (password is unaffected). Setting a connection's
  credentials in Clerk is **Dashboard-only** (no Backend API).

## Prerequisites

- The new domain is an **active Cloudflare zone** on the account, and the GHA
  `CLOUDFLARE_API_TOKEN` can manage it (a normal staging deploy provisioning `staging.<newdomain>`
  proves both).
- `clerk auth login`, then `clerk link` to the production app.
- Cloudflare API access for DNS (the Cloudflare MCP `cloudflare_execute`, or the Dashboard).

## Procedure

### 1. Rebrand + add the domain (one PR)

- Change the public copy and App Store discovery metadata (see "What a rebrand changes" #1).
- Add the new domain as an **additional** Custom Domain: `newname.tld` to the top-level
  (prod) `routes` and `staging.newname.tld` to `env.staging.routes` in
  `apps/frieren/wrangler.jsonc` — keep the old domains for now (add → verify, no flip).
- `pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test`. Merge → staging auto-deploys
  and provisions `staging.newname.tld`.

### 2. Rehearse on staging

Staging's Clerk is a **dev** instance (permissive origins), so `staging.newname.tld` works with
**no Clerk change** (CORS accepts it; confirm with a real sign-in). Note this does **not**
rehearse the prod `change_domain` — that is the one step staging cannot validate.

### 3. (Optional) prepare the new Google OAuth project

New Google Cloud project → OAuth client (Web application): redirect URI
`https://clerk.newname.tld/v1/oauth_callback` (copy the exact string from the Clerk Dashboard),
JS origin `https://newname.tld`, consent screen configured, publishing status **In production**.
The redirect URI is deterministic, so this can be done in advance.

### 4. Prod cutover

There is a brief auth-downtime window from step 2 until step 5 lands. Few users; acceptable.

1. **Release** so prod serves the rebranded client + the new-domain route (release-please →
   `frieren-v*` tag → prod deploy).
2. **`change_domain`** (retires old-domain auth — the destructive, gated step):
   `clerk api /instance/change_domain -X POST -d '{"home_url":"https://newname.tld"}' --app <app> --instance prod --yes`
3. **Create the 5 Clerk CNAMEs** in the new zone, **DNS-only (not proxied)** — exact targets
   from `clerk api /domains --app <app> --instance prod`:
   `clerk.`, `accounts.`, `clkmail.`, `clk._domainkey.`, `clk2._domainkey.`
   (via Cloudflare MCP `cloudflare_execute` `POST /zones/<id>/dns_records` with `proxied:false`,
   or the Dashboard).
4. **Wait** until `clerk deploy status` shows dns/ssl/mail **complete** (a few minutes).
5. **Swap the publishable key**: set the **`production`-environment** GitHub secret
   `FRIEREN_CLERK_PUBLISHABLE_KEY` to the new `pk_live_…`, then **redeploy prod**
   (`gh workflow run deploy-frieren-production.yml -f ref=frieren-vX.Y.Z`) so the client rebuilds
   with it. (The worker doesn't read the key, so no new release is required for auth.)
6. **Google**: paste the new project's Client ID/Secret into Clerk Dashboard → Google connection
   → *Use custom credentials*, and confirm its redirect URI matches step 3's `clerk.newname.tld`.
7. **Tell users** the new domain. No redirect (few users; the old domain simply stops working
   for auth).

### 5. Verify

- `clerk deploy status` = complete.
- The deployed client bundle carries the new `pk_live_…` (decodes to `clerk.newname.tld$`); the
  FAPI `/v1/client` on the new domain returns **200** (not the domain-lock 400).
- ⚠️ **DNS negative cache**: right after creating records, local resolvers cache `NXDOMAIN`.
  Verify globally with public resolvers (`dig @1.1.1.1 accounts.newname.tld`) and force-IP
  (`curl --resolve accounts.newname.tld:443:<ip> …`). If users hit `ERR_NAME_NOT_RESOLVED`,
  tell them to flush DNS / try cellular — it is not a real failure.
- A real sign-in (password **and** Google) on `newname.tld`.

### 6. Clean up

- Retire the old-domain route from the worker (PR → next release); optionally drop its DNS/zone.
- Refresh the vestigial `vars.CLERK_PUBLISHABLE_KEY` so it isn't a stale key.
- Delete any now-unused GitHub secrets.

## Mistakes not to repeat

1. **Never `wrangler deploy` manually.** The vite plugin ignores `--env`; the environment is set
   at build via `CLOUDFLARE_ENV`, so a manual deploy hits prod. Deploy through GitHub Actions.
2. **Don't trust a CORS reflection** as proof Clerk accepts a new domain — prod keys are
   domain-locked; you must `change_domain`.
3. The publishable key that matters is the **client's** `VITE_CLERK_PUBLISHABLE_KEY` (the
   `production` GH env secret), **not** the worker `vars.CLERK_PUBLISHABLE_KEY`.
4. Expect **DNS negative-cache** after creating records; verify via public resolvers before
   assuming something is broken.
5. Do the reversible work first (copy + add-domain), and gate the destructive `change_domain`
   explicitly.

## Tools

- Code/scans/tests: `rg`, Node, `pnpm`, Vitest.
- Cloudflare (Workers, DNS, custom domains): the Cloudflare MCP (`cloudflare_execute` runs code
  against the CF API), plus `dig`/`curl`. DNS records are created directly against the zone.
- Clerk: [CLI](https://clerk.com/docs/cli) + [Backend API](https://clerk.com/docs/reference/backend-api)
  (`clerk api /instance/change_domain`, `clerk api /domains`, `clerk deploy status`). Social-connection
  credentials and Account Portal branding are Dashboard-only.
- Deploys/releases: GitHub Actions + `gh` (`gh workflow run`, `gh secret set --env production`).

Relevant Clerk docs: [changing domains](https://clerk.com/docs/guides/development/deployment/changing-domains),
[Google connection](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/google).

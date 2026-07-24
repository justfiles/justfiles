# Kodama rebrand runbook

Migrate the public product from **Spud** at `spud.computer` to **Kodama** at
`mykodama.app`, including the macOS app and app bundle IDs, without losing user data.
Brief downtime and a fresh sign-in are acceptable.

## Decisions

- Keep all infrastructure and internal names stable: `frieren`, `Frieren`,
  `frieren-staging`, Durable Object namespaces, R2 buckets, source directories, and
  internal schema names.
- Keep the existing **production Clerk instance**. Creating a new instance would create
  new user IDs and therefore new per-user Durable Objects.
- Use `app.justfiles.frieren.*` as the permanent first-party bundle-ID namespace.
  Keep `justfiles.app` registered.
- Treat npm package names as immutable distribution identities. Keep the existing
  `@spud-computer/*` package names unless removing that historical name is worth a
  second, simultaneous package migration.
- Use a one-off, explicit migration. Do not carry legacy-ID resolution in the runtime.
- Keep `spud.computer` as a redirect for at least 12 months.

## Hard safety gates

Do not migrate or redirect until all of these pass:

1. Every production Clerk user has a migration dry-run result.
2. Every affected Durable Object has a recorded SQLite
   [PITR bookmark](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)
   and a verified in-volume backup of the paths being changed.
3. Writes from old web and macOS clients are stopped.
4. Users with browser-local profiles have exported them or explicitly accepted losing
   that local-only profile. Browser storage cannot be moved between origins.
5. New app-store package versions and their exact jsDelivr bytes are available.
6. Any migration conflict stops that user; nothing is overwritten.

Do not run blob garbage collection or delete old npm versions/backups during the
cutover.

## Open preflight gaps

- [ ] Link the Clerk CLI to the existing production instance. The checked-in/local
  setup only establishes development access; production credentials were not available
  during this investigation.
- [ ] Grant the connected Cloudflare credential `Zone / DNS / Edit` on
  `spud.computer` and `mykodama.app`; it currently has read access but cannot create
  Clerk's CNAMEs.
- [ ] Inventory browser-local profiles and any production IDs older than
  `computer.spud.*`.
- [ ] Inventory OAuth callbacks, webhooks, JWT/JWKS consumers, allowed origins, CSP,
  passkeys, and redirect allowlists.
- [ ] Confirm npm publishing credentials/2FA. The default is to retain
  `@spud-computer/*` as a stable, non-public implementation detail.

## Target identifiers

| Current ID | Permanent ID |
| --- | --- |
| `computer.spud.host` | `app.justfiles.frieren.host` |
| `computer.spud.code` | `app.justfiles.frieren.code` |
| `computer.spud.files` | `app.justfiles.frieren.files` |
| `computer.spud.notes` | `app.justfiles.frieren.notes` |
| `computer.spud.paint` | `app.justfiles.frieren.paint` |
| `computer.spud.settings` | `app.justfiles.frieren.settings` |
| `computer.spud.crossword` | `app.justfiles.frieren.crossword` |
| `computer.spud.doom` | `app.justfiles.frieren.doom` |
| `computer.spud.draw` | `app.justfiles.frieren.draw` |
| `computer.spud.pixel` | `app.justfiles.frieren.pixel` |

Use the logical app ID as `CFBundleIdentifier` for first-party projected macOS apps.
For third-party wrappers, use
`app.justfiles.frieren.wrapper.<stable-hash-of-logical-app-id>`; do not claim the
publisher's native bundle ID.

If production data contains older `app.spud.*` or `app.frieren.*` IDs, add each exact
alias to the reviewed migration map. Never migrate by prefix substitution.

## Tools

| Work | Preferred automation | Notes |
| --- | --- | --- |
| Code, scans, tests | `rg`, Node, `pnpm`, Vitest | Keep public brand/domain/ID constants centralized. |
| Workers, domains, DNS, logs | Installed Cloudflare MCP/API tools; `wrangler`; Cloudflare observability tools | Cloudflare MCP can inspect and mutate Workers and domains. DNS changes require `Zone / DNS / Edit` for both zones. |
| Cloudflare guidance | Installed Cloudflare docs MCP | Use current docs rather than remembered API shapes. |
| Clerk configuration | [Clerk CLI](https://clerk.com/docs/cli) and [Backend API](https://clerk.com/docs/reference/backend-api) | `clerk auth login`, `clerk link`, `clerk deploy --mode agent`, `clerk users list`, `clerk impersonate`, and `clerk api` cover most work. |
| Clerk implementation help | [Clerk MCP](https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server) | Documentation/snippets only; its two tools do **not** mutate a Clerk account. Install with `clerk mcp install`. |
| Browser verification | `pnpm run verify:ui`, `playwright-cli`, `curl`, `dig` | Test signed-out, signed-in, PWA update, paths, queries, and redirects. |
| macOS verification | build/install scripts, `codesign`, `lsregister` | A new host bundle ID resets notification permission. |
| Review/release | GitHub app/tools and `gh` | Keep migration code and its later deletion reviewable. |

Relevant Cloudflare docs:

- [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Wrangler Durable Object bindings](https://developers.cloudflare.com/workers/wrangler/configuration/#durable-objects)
- [Cloudflare redirects](https://developers.cloudflare.com/rules/url-forwarding/)
- [DNS records](https://developers.cloudflare.com/dns/manage-dns-records/)

## Run order

### 1. Prepare and rehearse

1. Rehearse the whole sequence on `staging.mykodama.app`.
2. Change public names, copy, icons, PWA manifest, metadata, account-provider copy, npm
   indexer user-agent, and the macOS visible app/folder names to Kodama. Keep internal
   `frieren` names unchanged.
3. Centralize:
   - `PUBLIC_BRAND = "Kodama"`
   - production/staging origins
   - the first-party ID map above
4. Add a regression test or repository scan that rejects `computer.spud.*`,
   `app.spud.*`, and public `spud.computer` references outside migration fixtures and
   historical docs.
5. Ship a transition release to `spud.computer` that unregisters `/sw.js`, deletes its
   caches, and tells local-profile users to export. Keep it live until every known user
   has loaded it. A stale service worker can otherwise serve the old app before an edge
   redirect is reached.
6. Build, but do not retain, a one-off migration:
   - temporary `migrateAppIdsV1({ dryRun })` RPC on `Frieren`;
   - temporary Worker bound to the existing `frieren` Durable Object class with
     `script_name: "frieren"`;
   - explicit old-to-new ID map;
   - authenticated operator-only entry point;
   - per-user JSON result and non-zero exit on any conflict.
7. Publish new versions of every store-distributed first-party package whose manifest
   ID changes. Currently this includes `@spud-computer/code`,
   `@spud-computer/draw`, and `@spud-computer/pixel`. Verify the pinned npm version,
   `dist/manifest.json`, entry files, and hashes through jsDelivr. Do this **before**
   changing the production catalog.

The current indexer intentionally rejects an npm package that changes its ID. Pause its
hourly schedule during the cutover and make one reviewed catalog replacement keyed by
npm package name. Do not publish old and new IDs as duplicate apps.

### 2. Preflight production

1. Authenticate the agent:
   - Cloudflare credentials with Workers, R2, Durable Objects, routes/custom domains,
     observability, and DNS Edit access;
   - `clerk auth login`, then link the existing production application.
2. Save `clerk deploy --mode agent` output and enumerate all users with
   `clerk users list` or `clerk api /users`.
3. Inventory each user's installed IDs and all affected paths. The dry run must report
   source existence, destination conflicts, counts, and sizes.
4. Identify social OAuth providers, webhooks, CSP/allowed origins,
   `authorizedParties`, allowlisted redirects, JWT issuers/JWKS consumers, and any
   passkeys. Record their required new URLs.
5. Confirm `mykodama.app` is active in Cloudflare, inspect CAA records with
   `dig mykodama.app +short CAA`, and attach `mykodama.app` to the existing `frieren`
   Worker as an additional Custom Domain.
6. Contact the few users: ask them to close all Spud browser tabs and the macOS app,
   export local-only profiles, and expect a new sign-in and notification prompt.

### 3. Freeze and back up

1. Put both old and new origins in maintenance mode and stop/pause the app-store
   indexer. Reject old-client API and WebSocket writes.
2. Stop the macOS app and daemon on each migrated Mac.
3. Run the production dry run again. Abort the whole cutover on an unexpected ID or
   conflict.
4. For each Clerk user:
   - record the Durable Object PITR bookmark;
   - copy `/system/os-state.json` and every affected `/applications`, `/state`, and
     `/data` path beneath `/system/migration-backups/app-ids-v1/`;
   - verify the copied path list, sizes, and content hashes before mutation.

PITR protects Durable Object SQLite metadata for 30 days. The path backup protects the
application layout. R2 blobs are separate, so blob GC remains disabled until acceptance.

### 4. Migrate IDs and local macOS data

For each user, in one serialized migration:

1. Move `/applications/<old>` to `/applications/<new>` and rewrite the manifest ID.
2. Move `/state/<old>.json` to `/state/<new>.json`.
3. Move `/data/<old>` to `/data/<new>`.
4. Rewrite all app-ID keys/references in `/system/os-state.json`, including windows,
   ordering, focus, maps, and placements.
5. Rewrite local `/.state/installing` entries if present.
6. Re-read every destination and return a result containing the PITR bookmark, moved
   paths, hashes/counts, rewritten references, and remaining legacy paths.

Never call `kernel.uninstall()` for this migration: it deletes app state and data.
If both old and new destinations exist, preserve both and stop for manual resolution.

Atomically replace the community catalog entries with the already-published package
versions and new IDs, then verify every catalog URL and hash.

On each Mac, the one-off installer should:

1. Refuse to run while Spud/Kodama processes are active.
2. Move `~/Library/Application Support/spud` to
   `~/Library/Application Support/frieren`; abort if both are non-empty.
3. Run the same Volume migration and checks.
4. Unregister/remove the old projected wrappers and rebuild them under
   `~/Applications/Kodama Apps`.
5. Install `Kodama.app` with bundle ID `app.justfiles.frieren.host`.

### 5. Move Clerk and deploy Kodama

Use the same production Clerk instance.

1. Change its home URL with the documented
   [`POST /v1/instance/change_domain`](https://clerk.com/docs/guides/development/deployment/changing-domains)
   endpoint and `{"home_url":"https://mykodama.app"}`. Prefer authenticated
   `clerk api`; the documented `curl` call is the fallback.
2. Read the new domain records from Clerk. Create the requested CNAMEs in Cloudflare as
   **DNS only**, not proxied.
3. Update social OAuth callbacks, webhooks, CSP/allowed origins, `authorizedParties`,
   redirects, and external JWT issuer/JWKS settings.
4. Clerk generates a new publishable key. Update `CLERK_PUBLISHABLE_KEY` in the Worker
   configuration and deploy `frieren`; keep the existing production secret unless
   Clerk explicitly rotates it.
5. Deploy Clerk certificates. Current public docs expose this as a Clerk Dashboard
   action; use `clerk deploy --mode agent` to verify completion.
6. Bring up `https://mykodama.app` while `spud.computer` remains in maintenance mode.

Clerk's [production guide](https://clerk.com/docs/guides/development/deployment/production)
requires Cloudflare Clerk CNAMEs to be DNS-only and notes that restrictive CAA records
can block certificate issuance.

### 6. Verify, then redirect

Because there are few users, verify every migrated user, using `clerk impersonate` when
appropriate:

- same Clerk user ID and therefore the same Durable Object;
- expected app count and only new IDs;
- critical app files/data and OS layout match pre-migration hashes/counts;
- each first-party and community app opens;
- write, reload, sync, sign-out, and sign-in work;
- no migration conflicts or legacy production paths remain;
- macOS app launches, projected apps open, and notification permission can be granted.

Only after all users pass:

1. Remove `spud.computer` from the application Worker.
2. Attach it to a tiny `frieren-legacy-redirect` Worker that preserves path and query and
   returns a temporary `307` to `https://mykodama.app`.
3. Test ordinary navigation, deep links, query strings, and a browser that previously
   installed the PWA.
4. Change the redirect to `308` after the observation window.
5. Re-enable the app-store indexer.

### 7. Clean up

After every user confirms success:

- remove the migration RPC, temporary migrator Worker, operator secret, maintenance
  gate, and macOS migration code;
- keep the explicit migration results and PITR bookmarks in a private operations record;
- keep in-volume backups through the 30-day PITR window, then delete them deliberately;
- keep old npm versions and the `spud.computer` redirect;
- update support, legal, email, analytics, social previews, and Clerk Account Portal
  branding. Account Portal branding is Dashboard-only according to the Clerk CLI docs.

## Rollback

Any failed user blocks the redirect.

1. Keep maintenance mode enabled and the indexer paused.
2. Restore the old catalog and old client build.
3. Restore affected paths from `/system/migration-backups/app-ids-v1/`. Use the recorded
   Durable Object PITR bookmark only if the in-volume restore is insufficient.
4. Restore the old macOS support directory and wrappers.
5. If Clerk/domain setup failed, change the same instance back to `spud.computer`,
   deploy the resulting publishable key, and reattach the old Custom Domain.
6. Verify old-origin reads and writes before lifting maintenance.

## Manual work that may remain

- Approve production Clerk login/secret access and Cloudflare DNS Edit permission.
- Approve npm publishing/2FA for the three store-distributed packages.
- Update OAuth provider consoles or external JWT consumers that lack usable APIs.
- Select Clerk's **Deploy certificates** button and update Account Portal branding.
- Contact users about local-only browser profiles and run the macOS installer.

Everything else can be implemented and executed by an agent with the installed
Cloudflare tools, Clerk CLI/API, repository access, and GitHub tools.

## Future rebrand policy

- Public brand and origins live in one small configuration module; internal resource
  names never contain the public brand.
- `app.justfiles.frieren.*` IDs and npm package names are immutable. A third-party
  package changing its manifest ID is a new app unless a future, explicit
  package-signed migration format is designed.
- The app-store catalog remains bound both ways: one npm package to one logical ID.
- A static test prevents public-brand strings from leaking into infrastructure and IDs.
- Bundle-ID migrations remain removable operations scripts, not permanent boot logic.

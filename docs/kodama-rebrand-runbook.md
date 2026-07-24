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
- No redirect. With few users we simply point them at `mykodama.app`; both domains
  keep serving the same Worker, and the old one is dropped from the Worker's `routes`
  later once everyone has moved. (Avoids a redirect Worker, a service-worker transition
  release, and the `307`→`308` dance.)

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

macOS projected wrappers currently share one reserved CFBundle namespace,
`computer.spud.app.<logical-app-id>` — generated at runtime by
`apps/spud-mac/daemon/materialize.ts` and at build time by
`apps/spud-mac/native/build.sh` — chosen so a mini-app whose id looks like a real
native bundle ID (e.g. `com.company.todo`) can't collide in LaunchServices. This
migration retires that single namespace and splits it into two stable schemes:

- First-party projected apps take the logical app ID as their `CFBundleIdentifier`
  (e.g. `app.justfiles.frieren.code`).
- Third-party wrappers take
  `app.justfiles.frieren.wrapper.<stable-hash-of-logical-app-id>`; never claim the
  publisher's native bundle ID.

Both the host (`computer.spud.host`) and every `computer.spud.app.*` wrapper must be
unregistered from LaunchServices during the macOS step. Changing the host bundle ID
resets notification permission.

If production data contains older `app.spud.*` or `app.frieren.*` IDs, add each exact
alias to the reviewed migration map. Never migrate by prefix substitution.

## Tools

| Work | Preferred automation | Notes |
| --- | --- | --- |
| Code, scans, tests | `rg`, Node, `pnpm`, Vitest | Each app owns its manifest ID at its package boundary; centralize only the cross-reference constants (allowlists, reserved prefixes) and the public brand/origins. |
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
3. Change each app's declared manifest ID once at its own boundary (each
   `packages/app-*/vite.config.ts`, plus the macOS mirrors in
   `apps/spud-mac/native/build.sh`, `daemon/materialize.ts`, `daemon/builtins.ts`, and
   the Swift launcher/grid). Do not hoist per-app IDs into a shared module — an app's
   ID is its identity. Centralize only:
   - `PUBLIC_BRAND = "Kodama"`
   - production/staging origins
   - the small cross-reference set that names *other* apps' IDs: `systemAllowlist` in
     `apps/frieren/worker/frieren.app.ts`, `apps/frieren/shared/devkit.allowlist.ts`,
     and the indexer's `RESERVED_PREFIXES`.
4. Add an allowlist-based regression scan over production source (non-test, non-`.md`)
   that rejects `computer.spud.*`, `app.spud.*`, and public `spud.computer` references.
   Migrate incidental test fixtures and sample IDs to `app.justfiles.frieren.*` so the
   scan stays blanket. Exempt only: the migration's old-to-new map fixture; the indexer
   and its test that deliberately exercise retired-prefix reservation (anti-squatting);
   and historical docs.
5. Tell local-profile (signed-out) users to export first — browser storage is
   per-origin and can't move to the new domain. Signed-in users need nothing: their
   data lives in the per-user Durable Object and reappears on the new domain after
   sign-in. (No service-worker transition release is needed because there is no
   redirect to race.)
6. Build, but do not retain, a one-off migration:
   - explicit old-to-new ID map and a pure `Volume` migrator that backs up each
     touched path under `/system/migration-backups/app-ids-v1/`, moves
     `/applications`, `/state`, `/data`, rewrites the manifest id and every id in
     `os-state.json`, and aborts the whole run on any old/new clash (never overwrites);
   - a `migrateAppIdsV1({ dryRun })` RPC on `Frieren`, kept for operator dry-runs and
     verification.

   **Implemented (PR #254):** rather than an operator Worker + freeze, the migrator
   runs automatically in the client boot flow — after the initial sync settles and
   **before** built-ins seed — so only legacy ids exist at that moment, the move is a
   clean rename, and no duplicate tiles ever surface. It is idempotent (a no-op once no
   legacy ids remain) and best-effort (a failure never bricks boot). This is temporary
   boot logic; see §7 for removal. The `Frieren.migrateAppIdsV1` RPC still exists for
   operator dry-run inspection and post-migration verification.
7. Publish new versions of every store-distributed first-party package whose manifest
   ID changes. Currently this includes `@spud-computer/code`,
   `@spud-computer/draw`, and `@spud-computer/pixel`. Verify the pinned npm version,
   `dist/manifest.json`, entry files, and hashes through jsDelivr. Do this **before**
   changing the production catalog.

The current indexer intentionally rejects an npm package that changes its ID. Pause its
hourly schedule during the cutover and make one reviewed catalog replacement keyed by
npm package name. Do not publish old and new IDs as duplicate apps.

Add `app.justfiles.frieren.` to the indexer's reserved-prefix list (`RESERVED_PREFIXES`
in `apps/frieren/worker/appstore/indexer.ts`) so the new namespace is honoured only from
our npm scope, and keep `computer.spud.`, `app.spud.`, and `app.frieren.` reserved so no
one can squat the retired IDs.

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

### 6. Verify, then point users at the new domain

Because there are few users, verify every migrated user, using `clerk impersonate` when
appropriate:

- same Clerk user ID and therefore the same Durable Object;
- expected app count and only new IDs;
- critical app files/data and OS layout match pre-migration hashes/counts;
- each first-party and community app opens;
- write, reload, sync, sign-out, and sign-in work;
- no migration conflicts or legacy production paths remain.

Only after all users pass:

1. Attach `mykodama.app` to the application Worker as an additional Custom Domain
   (both domains now serve the same Worker).
2. Tell users to use `https://mykodama.app`. There is no redirect: the old domain keeps
   working, so nobody is stranded.
3. Re-enable the app-store indexer.
4. Later, once traffic to the old domain has stopped, drop it from the Worker's `routes`
   (a one-line config change).

### 7. Clean up

The id migration ships as temporary client **boot logic** (it runs once per user on
login, before built-ins seed; see PR #254), not an operator script. So removal is a
normal code release, made **after every production user has logged in post-rebrand at
least once** and been verified — at which point the migrator is already a no-op for
everyone.

Delete, in one reviewed release:

- `apps/frieren/shared/migrate-app-ids.ts` and `migrate-app-ids.test.ts` (the pure
  migrator, `migrateAppIdsOnce`, `runAppIdMigrationV1`, `sweepMigrationBackups`,
  `migrationBackupPending`, and `APP_ID_MIGRATION_V1`);
- the `migrateAppIdsOnce(fs)` call, the local-only `sweepMigrationBackups(fs, …)` call,
  and the migration-only `fs.flush()` / imports in `apps/frieren/src/os/runtime.ts`
  (leave `seedBuiltins` and its bootstrap wait);
- the `sweepMigrationBackups(volume, …)` call + import in
  `apps/frieren/worker/daily-maintenance.ts`;
- the `migrateAppIdsV1` RPC, the `alarm()` re-arm block guarded by
  `migrationBackupPending`, and both imports in `apps/frieren/worker/frieren.ts`;
- the `migrate-app-ids.ts` entry from the `EXEMPT_FILES` list in
  `apps/frieren/shared/no-legacy-app-ids.test.ts` (its target no longer exists).

Keep permanently:

- the `app.justfiles.frieren.*` ids;
- the retired `computer.spud.` / `app.spud.` / `app.frieren.` entries in the indexer's
  `RESERVED_PREFIXES` (anti-squat) and the `no-legacy-app-ids` guard itself;
- old npm versions; both domains keep serving until traffic to the old one stops, then
  drop the old `routes` entry.

Then, separately:

- keep the explicit migration results and PITR bookmarks in a private operations record;
- the in-volume backups under `/system/migration-backups/app-ids-v1/` are swept
  automatically once past a 30-day retention window (the client boot runs
  `sweepMigrationBackups`; PR #256), so they never linger in a user's synced volume;
  the DO SQLite PITR window remains the deeper net underneath;
- update support, legal, email, analytics, social previews, and Clerk Account Portal
  branding. Account Portal branding is Dashboard-only according to the Clerk CLI docs.

## Rollback

Any failed user blocks the cutover.

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

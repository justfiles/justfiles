# Spud app store (community, npm-indexed)

> Status: **designed, not started.** Install/uninstall/update machinery already
> exists (`packages/app/appstore.ts`); this doc specifies the *community
> discovery layer* on top of it. Public third-party installs stay gated behind
> the sandbox work listed under **Trust** below.
>
> Naming: **spud** (spud.computer) is the public product name; *frieren* is the
> internal codename for the web client. Everything public-facing here — the npm
> keyword, docs, catalog URLs — says spud.

## Model: an index, not a marketplace

Decision after surveying the field: platforms sit on a spectrum from
"we host and review everything" (Figma, VS Code — heavy infra, heavy liability,
and VS Code still ships malware despite Microsoft-scale scanning) through
"PR-reviewed pointer list" (Obsidian, Homebrew — medium effort, authors host
bytes) to "npm keyword crawl, zero review" (pi's `pi-package` gallery, Gatsby
plugin library, Yeoman generators — near-zero effort).

We take the right edge: **the store is a search index over npm.** We never host,
build, review, or distribute third-party code. Authors publish to npm; clients
download bytes from npm's public CDN (jsDelivr); we publish metadata + pinned
hashes and keep a denylist. Legally and operationally we are a search engine,
not a distributor.

This also dissolves the TypeScript problem: `npm publish` forces the author to
build (pi gets away with pointing at raw TS repos only because it runs in Node
and loads extensions via jiti with a real `node_modules`; browser-run apps
can't). The published tarball already contains the built
`dist/manifest.json + app.js + gui.js` that the kernel installs — the author's
machine is the build farm.

## Sequencing: two parallel tracks

The store and the sandbox are **independent workstreams** — neither builds on
the other's code — with a single **deployment dependency**: public third-party
installs only get enabled once the sandbox track lands.

- **Track A — the store** (this doc): template keyword, indexer, community
  catalog, jsDelivr-backed `AppStore`, omnibar discovery, consent sheet. Can be
  built and shipped end-to-end behind a flag, exercised with first-party
  `computer.spud.*` apps published to npm (see the namespace section below) —
  those are already trusted, so the sandbox gate doesn't block them.
- **Track B — the sandbox** (`IFRAME_ISOLATION_PLAN.md`): Step 4 (reducer
  worker into the iframe, Topology B — or the SES fallback recorded in its risk
  gate), plus a CSP on `FRAME_SRCDOC` (its Step 5a) so the frame's network is
  deny-by-default. Steps 1–3 (GUI in an opaque-origin iframe) are already
  shipped.

Flag flip for the public store = Track B's gate met **+** the consent sheet
**+** re-consent on capability escalation (both Track A items). Until then the
community catalog can exist, be browsable, and serve first-party apps.

## Foundation: apps are just files (unchanged)

An app is a directory of files in the user's volume:

```txt
/applications/<id>/   app.js, gui.js, manifest, icon, assets
/state/<id>.json      app state
/data/<id>/...        app user data
```

Installing = writing files into `/applications/<id>/`; uninstalling = deleting
them. `packages/app/appstore.ts` already provides the whole install/update
machine: the `AppStore` interface (`builtins()`, `latest(id)`, `read()`),
per-file `sha256-` verification before bytes touch the volume, whole-app hash
markers, and a monotonic no-downgrade `reconcile`. The community store is *one
more `AppStore` implementation* plus a catalog feed — no kernel changes.

## Author flow

1. `pnpm create @justfiles/app my-app` (template gains: keyword `spud-app`,
   `files: ["dist"]`, `prepublishOnly: "pnpm build"`).
2. Build, test locally (zip install already works).
3. `npm publish`. That's the submission. Updates = publish a new version.

One docs page on spud.computer explains this. No submission form, no PR, no
account with us — npm identity is the publisher identity (and npm's OIDC
"trusted publisher" provenance shows up in their search API for free).

## App ids: the `computer.spud.*` namespace

Bundle ids are reverse-DNS. First-party apps move to the reverse of the public
domain (spud.computer):

- **Rename**: built-ins currently use `app.frieren.*` (e.g.
  `app.frieren.files`); they become `computer.spud.*` (`computer.spud.files`).
  The id is storage-load-bearing — `/applications/<id>/`, `/state/<id>.json`,
  `/data/<id>/` are all keyed by it — but with no live users there is **no
  migration**: existing dev/personal volumes are simply wiped (the sync-status
  menu's volume reset) after the rename deploys, and first-boot seeding
  reinstalls built-ins under the new ids. Template/doc examples
  (`app.example.*` in `packages/create-app`, `docs/app.md`) stay
  third-party-shaped.
- **First-party = the prefix.** In the final catalog, any app whose id starts
  with `computer.spud.` is first-party, regardless of how it's distributed.
  Clients derive the "by spud" badge (and trust decisions like skipping the
  community disclaimer) from the prefix alone — safe because the indexer guards
  it (below).
- **Pre-installed ⊂ first-party.** The deploy-shipped built-in catalog stays a
  small bounded set; **most first-party apps ship through the store like
  everyone else's** — published to npm with a `computer.spud.*` id, indexed,
  installed from jsDelivr. So "first-party" stops implying "pre-installed";
  it only means "authored by us, in our namespace".
- **Prefix guard.** The indexer accepts a `computer.spud.*` (or legacy
  `app.frieren.*` / `app.spud.*`) id **only** from packages published under our
  npm scope (`@spud-computer/*`, registered — scope ownership is enforced by
  npm itself, which makes it the authenticator). Any other package declaring a
  reserved-prefix id is skipped and flagged, same as an id-binding conflict.
  Everyone else must use their own reverse-DNS namespace.
- **The id comes from the manifest, not the npm name.** Deriving
  `id = f(package name)` would kill squatting by construction, but the id is
  storage identity (`/applications/<id>/`, `/state/<id>.json`, `/data/<id>/`)
  and must outlive the distribution channel: zips and app-code drafts have no
  npm name, an app-code app later published to npm must keep its id (or its
  users' installs orphan), and an author must be able to rename an npm package
  without stranding user data. Instead the indexer enforces the id ↔ package
  binding **both ways**, first claim wins, stable across versions: a package
  whose later version changes its id is skipped, and no other package can claim
  a bound id. Reverse-DNS ids outside our reserved prefixes are not
  ownership-verified (same as Obsidian); the user-facing trust anchor is the
  npm publisher on the consent sheet, not the id string.

## Indexer

A scheduled job (cron trigger on the existing frieren worker, or a scheduled
GitHub Action) every few hours:

1. `GET registry.npmjs.org/-/v1/search?text=keywords:spud-app` (paginate).
2. For each package@version not yet indexed:
   `GET data.jsdelivr.com/v1/packages/npm/<name>@<version>` — returns the file
   tree **with per-file sha256** (verified live: hashes + CORS `*` + immutable
   cache).
3. Validate: `dist/manifest.json` exists and parses; app id well-formed
   reverse-DNS; required files present; reserved prefixes (`computer.spud.*`,
   legacy `app.frieren.*`/`app.spud.*`) only from our npm scope — see the
   namespace section's prefix guard.
4. **Bind app id ↔ npm package name, both ways, first claim wins.** A different
   package claiming an already-bound id is skipped (and flagged), and so is a
   later version of a package that changes its own id (see the namespace
   section for why the id lives in the manifest). This is the whole
   anti-squatting story for ids; npm's own namespace handles package names.
5. Apply the denylist.
6. Write the community catalog JSON to R2.

The indexer reads only metadata and hashes — third-party bytes never pass
through our infrastructure.

## Catalog

Extends the existing `Catalog`/`CatalogApp` shape (`packages/app/appstore.ts`)
with the source pointer:

```jsonc
{
	"schema": "spud/community-catalog/v1",
	"apps": [{
		"id": "com.example.notes",
		"name": "Notes",
		"version": "1.2.0",
		"npm": "example-spud-notes",        // package name; bytes resolve via jsDelivr
		"publisher": "npm:someuser",        // shown on the consent sheet
		"repository": "https://github.com/...", // from package.json, linkified in UI
		"description": "...",
		"files": [{ "path": "manifest.json", "hash": "sha256-…", "size": 812 }, …]
	}]
}
```

Pre-installed built-ins are untouched: they still co-ship with the deploy under
`/appstore/catalog.json` + `/appstore/apps/<id>/<version>/<path>` from the
static `ASSETS` binding. The community catalog is a second feed (served at
`/appstore.json`, R2-backed, worker-served) and carries everything
else — third-party apps **and** the first-party `computer.spud.*` apps that
ship via npm instead of the deploy. The earlier idea of keeping canonical
third-party bytes in R2 is **dropped** — it made us the distributor for no
benefit.

## Client

- **Bytes**: the community `AppStore.read` fetches
  `cdn.jsdelivr.net/npm/<name>@<version>/dist/<path>`. CORS-open, immutable,
  CDN-cached. The existing `install()` verifies every file against the pinned
  catalog hash, so a swapped byte at the same URL fails closed. Integrity comes
  from the hash pin, not from trusting the CDN.
- **Discovery (v1)**: community catalog entries become omnibar search
  candidates — name, publisher, install button, link to the npm page /
  repository. A browsable store app can layer on later without changing any of
  this.
- **Install consent**: a sheet showing the app's declared capabilities (the
  manifest already carries them), the publisher, and one line: *"Community app —
  not reviewed by spud. Source: npm/<name>."* First-party apps
  (`computer.spud.*`) show a "by spud" badge instead of the disclaimer.
- **Updates**: free — `reconcile` already calls `latest(id)` for non-builtins;
  point that at the community catalog. **Exception:** if a new version declares
  *more* capabilities than the installed one, do not auto-update — surface
  re-consent first.
- **spud-mac**: same catalog, same bundles, same `AppStore` interface; the
  daemon fetches the identical built artifacts (no TS-at-runtime special case,
  even though Node could).

## Moderation & liability posture

- **Denylist, nothing more**: one JSON of banned npm names / app ids, applied by
  the indexer (and checkable by clients against already-installed apps). This is
  the DMCA/malware takedown lever — the minimum a platform needs — without ever
  promising review.
- Short developer-policy page + the install-time disclaimer (copy Obsidian's
  posture: not vetted, use at your own risk, removed on report; and pi's
  honesty: packages run with the access they declare — review before install).
- We index and hash; npm and jsDelivr host. No build service (running untrusted
  builds is the worst liability in this space), no PR review queue (reviewing
  makes you responsible for what you approved).

## Trust: what the sandbox does and doesn't cover yet

Current state (see `IFRAME_ISOLATION_PLAN.md`, Steps 1–3 **shipped**):

- ✅ **GUI** runs in an opaque-origin `sandbox="allow-scripts"` iframe
  (`gui-channel.ts`): no host DOM, no cookies, no Clerk token, no
  localStorage/IDB volume. Its only authority is the kernel MessagePort.
- ❌ **Reducer** worker is still created in the host realm
  (`sandbox.worker.ts`) → same-origin, can `fetch` with the user's cookies.
  Closing this is `IFRAME_ISOLATION_PLAN.md` Step 4 (Topology B), or SES
  hardening if nested workers are blocked.
- ❌ **No CSP on the frame document** — even an opaque-origin iframe can `fetch`
  / beacon / `<img>` to arbitrary external hosts, so data an app *legitimately*
  holds (its chroot files, AI/email capability results) is exfiltratable. Fix:
  `<meta http-equiv="Content-Security-Policy">` in `FRAME_SRCDOC` allowing only
  `blob:` script/imports and nothing else; blob workers inherit the creator
  document's CSP, so this covers the Topology-B reducer too. Network access then
  becomes deny-by-default — a future *capability* (kernel-mediated fetch with
  consent), not ambient.
- ⚠️ Same-process opaque origin: Spectre-class cross-frame reads remain
  theoretically possible; documented trade-off, escalate to a dedicated
  cross-origin domain only if that enters the threat model.
- Hash pinning gives **integrity** (bytes can't change after indexing), not
  **safety** (the author can publish malicious bytes as v1.0.1 — the rug pull).
  No indexed store fixes that; the mitigations are the capability consent sheet,
  re-consent on escalation, and the denylist.

**Gate for enabling public third-party installs:** Track B (Topology B or SES,
plus the frame CSP) + consent sheet + re-consent on capability escalation — see
"Sequencing: two parallel tracks". Until then, installs stay limited to
pre-installed built-ins, first-party `computer.spud.*` apps from the store, and
self-installed local zips.

## Implementation steps (Track A)

Five steps, each self-contained and landable on its own (sized so one step ≈ one
focused session; the earlier steps are prerequisites of the later ones, but every
step leaves the tree green and shippable). Track B is **not** re-broken-down
here — it is `IFRAME_ISOLATION_PLAN.md` Step 4 (Topology B) + Step 5a (frame
CSP), and can run in parallel with any of these.

### Step 1 — Rename bundle ids to `computer.spud.*` (S–M)

**Context.** Built-in ids are scattered across legacy prefixes: `app.frieren.*`
(files, notes, settings, paint), `app.code`, `app.justfiles.*` (counter,
crossword), `app.justbuddy.*` (doom). Everything first-party moves to
`computer.spud.<name>` before anything is published to npm. No migration —
there are no live users; existing dev/personal volumes get wiped and reseeded.

**Expectation.** All built-ins carry `computer.spud.*` ids; a fresh (or wiped)
volume seeds and runs normally; no reference to the old prefixes remains.

**How.**
- New ids in each `kernelHost({ id })` (`packages/app-*/vite.config.ts`, 8 apps).
- Update every id-keyed allowlist: `systemAllowlist: ['app.frieren.files']`
  (`worker/frieren.app.ts`, `src/apps/capabilities.client.ts`),
  `ACCOUNTS_FIRST_PARTY` (`worker/frieren.ts`), the devkit allowlist
  (`shared/devkit.allowlist.ts`), and the `isBuiltin` prefix fallback
  (`src/apps/manage.ts`).
- After deploy: reset existing volumes (sync-status menu → volume reset; local
  dev just clears its profile) so seeding reinstalls under the new ids.

**Verify.** `pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test`; then
`verify:ui` on a wiped profile — built-ins seed, open, and persist state under
the new ids; grep confirms the old prefixes are gone.

### Step 2 — Publishing pipeline: template + first app on npm (S)

**Context.** The store's submission mechanism is `npm publish`; nothing exists
yet. The npm scope `@spud-computer` is registered. This step creates the author
flow and one real published app for the indexer to find.

**Expectation.** `pnpm create @justfiles/app` output is publishable as a spud
app with zero edits beyond the id; one first-party canary app (e.g. counter or
crossword) is live on npm under `@spud-computer` with keyword `spud-app`.

**How.**
- Template `package.json`: keyword `spud-app`, `files: ["dist"]`,
  `prepublishOnly: "pnpm build"`; template README gains a short "publish to the
  spud store" section (seed for the spud.computer docs page).
- Publish the canary from its in-repo package (add the same three fields).
- No frieren code changes.

**Verify.** `registry.npmjs.org/-/v1/search?text=keywords:spud-app` returns the
canary; `data.jsdelivr.com/v1/packages/npm/<name>@<version>` lists
`dist/manifest.json` + `app.js` with hashes.

### Step 3 — Indexer + community catalog feed (M–L)

**Context.** The one new piece of infrastructure. Produces the community
catalog; never touches third-party bytes.

**Expectation.** A scheduled job builds the catalog in R2 from the
`spud-app` npm keyword, applying validation, the two-way id↔package binding,
the reserved-prefix guard, and the denylist; the frieren worker serves it at
`/appstore.json`; the canary app appears in it.

**How.**
- Cron trigger on the existing frieren worker (`wrangler.jsonc`; add the route
  to `run_worker_first` per the URL-scheme section).
- Pipeline per the Indexer section: npm search (paginated) → jsDelivr data API
  for new `package@version`s → validate manifest/id/files → binding + prefix
  guard (`@spud-computer` scope for reserved prefixes) → denylist → write
  catalog. The previous catalog in R2 **is** the binding store — read, merge,
  write; no extra database.
- Denylist: a JSON file (R2 or in-repo, deploy-updated) the pipeline filters by.
- Unit-test the pure pipeline (fixtures for: id conflict, id changed by a new
  version, reserved prefix from a foreign scope, malformed manifest,
  denylisted).

**Verify.** `pnpm test`; run the indexer once against real npm (local
`wrangler dev` scheduled-event trigger) and confirm the canary lands in
the catalog with pinned hashes; a fixture package claiming
`computer.spud.evil` from outside the scope is skipped and flagged.

### Step 4 — Community `AppStore` in the client: install + updates (M)

**Context.** The kernel-side machinery (`packages/app/appstore.ts` — install,
hash verify, monotonic reconcile via `latest(id)`) is done. This step gives it
a community-backed implementation, behind a dev flag.

**Expectation.** With the flag on, an app from the community catalog installs
into the volume with every file hash-verified from jsDelivr, launches, and
auto-updates on reconcile — except when a new version declares more
capabilities, which holds the update instead.

**How.**
- `communityAppStore()` next to `httpAppStore` (`shared/appstore.ts`): catalog
  from `/appstore.json`; `latest(id)` from it; `read()` fetches
  `cdn.jsdelivr.net/npm/<name>@<version>/dist/<path>` (entries carry `npm`
  name/version). Existing `install()` verifies the pinned hashes — no new
  integrity code.
- Chain it into the reconcile path for ids the built-in catalog doesn't carry
  (where `manage.ts`/boot resolve stores today).
- Escalation guard: before reinstalling a non-builtin, diff declared
  capabilities (installed manifest vs catalog manifest); on growth, skip and
  record the held update (consent UI lands in Step 5).
- Flag: a simple dev setting; default off.

**Verify.** `pnpm test` (store unit tests: hash-tamper rejection, escalation
hold); `verify:ui`: flag on → install the canary from the community catalog →
it launches; publish a patch → reconcile picks it up.

### Step 5 — Discovery UI + consent (M–L)

**Context.** Everything installable is now wired; nothing is discoverable.
v1 discovery is the omnibar, not a store app.

**Expectation.** Community-catalog apps appear as omnibar candidates with an
install action; installing shows the consent sheet (declared capabilities,
npm publisher, community disclaimer — or "by spud" badge for
`computer.spud.*`); a held update from Step 4 surfaces a re-consent prompt.
Public exposure stays behind the Track-B-gated flag.

**How.**
- Omnibar: merge community entries into search candidates (name/description),
  with installed-state awareness — "Install" vs "Open"; link to
  npmjs.com/package/<name> and the `repository` URL.
- Consent sheet before first install: capabilities from the catalog manifest,
  publisher, disclaimer/badge by prefix.
- Re-consent: surface held updates (Step 4's record) in the same sheet; accept
  → reinstall proceeds.
- Uninstall for community apps already works (`uninstallLocalApp`); make sure
  the omnibar reflects it.

**Verify.** `verify:ui`: search → consent → install → open; capability-escalated
update prompts before applying; first-party entry shows the badge, no
disclaimer.

**After both tracks:** flip the public flag (Track B gate + Steps 4–5 consent
items), publish the developer-policy page on spud.computer, and announce the
`spud-app` keyword. spud-mac adoption is a follow-up that reuses Step 4's
`AppStore` unchanged in the daemon.

## Non-goals (v1)

- GitHub-as-source (build problem, mutable tags, rate limits) — the repo link is
  display metadata only. A later power feature could compile SDK-only TS repos
  on-device via the app-code devkit compiler, pi-style.
- Ratings, comments, featured lists, paid apps, signing infrastructure
  (npm identity + pinned hashes + optional npm provenance cover v1).
- Hosting third-party bytes in R2.

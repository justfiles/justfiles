# Hosted apps

> Status: **desktop prerequisites landed; the standalone host is not in the tree.**
>
> #373 removed framework infrastructure, and #376/#379 made hosted bundles mounted,
> integrity-pinned app specs instead of synced copies. The host itself is prototyped
> on an unmerged branch, far enough to decode one-label subdomains into app ids and to
> run the registry pipeline of [`registry.md`](./registry.md); the shell, the standalone
> host adapter, publishing, and abuse controls below are not implemented anywhere.
>
> Let an author publish one app and get a URL anyone can open — no infra, no
> account required of the visitor. An **addition** to the local-first app system,
> not a replacement.
>
> `justapps.com` / `justapps.run` are placeholders.

## The shape

```text
justapps.com                    platform: accounts, publishing, store pages, docs
<publisher>-<app>.justapps.run  one origin per app — a normal web page
```

- **An app is a normal website** at its own origin. Routing, History, caching,
  service worker all behave normally.
- **Its data is its own** — a `@justfiles/fs` volume over IndexedDB on that
  origin. Not the desktop volume. No account needed.
- **The kernel still runs**, in the page, with the reducer in a Worker. It is
  `packages/app` unchanged behind a third host adapter.
- **The same bundle runs in the desktop.** The installer turns it into an app spec by
  adding source and integrity metadata; the app itself cannot choose that source.
- **No build service.** The author's machine or browser compiles; we store and
  serve immutable bytes.

The product is R2 + a routing worker + a static shell. No per-app compute, no build
farm, no second database, and — because the hostname is derived from the app id
rather than allocated — no name table either.

## v1 is anonymous-only

The scope that threatened to balloon was never the architecture — it was the
moderation apparatus. Two cuts keep this at indie scale:

**No account sync in v1.** Hosted apps store data in browser-local IndexedDB,
full stop. That removes the scoped sync endpoint, reachability-gated blob reads,
token minting, the consent screen, and the first-sync merge — most of the
remaining work and all of the security-critical work. The pitch survives intact,
and it is honest: *this app stores data in your browser*.

**No review gate on publishing**, per `APP_STORE_PLAN.md`'s existing posture and
pi's: apps run with the access they declare, users install at their own risk, we do not
review. Publishing still requires authenticated ownership and mechanical bundle
validation; those are integrity controls, not editorial approval. Keep `abuse@`, a DMCA
agent, and a kill switch. Drop screening, confusables checks, publish-time detection, and
preview domains until something forces them.

That is a statement about **publishing**, not about every surface — a store
listing can be gated later without reopening it. See
[Prior art: Puter](#prior-art-puter).

What makes that posture *fair* is origin isolation: a hostile app can only reach
its own origin's data, so "you took the risk" is true. It stops being true the
moment apps share an origin with the desktop's credentials — which is why apps
never live on `mykodama.app`.

### What the capability model does and does not cover

It governs what an app can **reach**. It says nothing about what an app **is**.

That line decides which liabilities consent actually closes:

- **Harm to the user's own data** — closed. Declared capabilities, an explicit
  install, no review, risk carried by the user. The npm / VS Code / Obsidian / pi
  position.
- **Harm to third parties, and hosting liability** — *not* closed, and consent is
  irrelevant to it, because the claim comes from a rights-holder or law
  enforcement rather than from our user. An "app" can be a static page serving
  pirated media and declare no capability at all.
- **Reputation** — not closed. Safe Browsing does not care that the user
  consented.

Phishing is the clearest case: a notes app declaring only storage can render a
pixel-perfect bank login, and the consent sheet will honestly say *this app wants
storage*. No capability system, sandbox, or CSP prevents an app from **drawing**
something.

So `abuse@`, a registered DMCA agent, and a kill switch are load-bearing, not
vestigial — they are the response mechanism that makes *not* gatekeeping viable.
Fast takedown substitutes for review.

Concretely, the whole apparatus:

- **Content on its own registrable domain**, never beside the auth origin, and
  **per-app hostnames** so a flag burns one app rather than a path space.
- **`noindex` by default** — phishing needs distribution; let authors opt in
  after verifying.
- **Unpublish is one registry flip.** Bundles are immutable behind the routing worker.
  Serve a **410** on a killed hostname rather than anything app-shaped, so a network
  re-crawl sees remediation. Response time is what Safe Browsing measures.
- **The service-worker trap**: a registered app-controlled worker can keep serving
  without reaching that 410. The root-scope worker must remain platform-controlled and
  its kill update must unregister itself and delete executable caches. This needs a
  browser proof; a routing-worker header alone is not an instant global takedown, and a
  fully offline client cannot learn that it was killed.
- **DMCA §512(c) safe harbour is conditional** — a designated agent registered
  with the US Copyright Office, a published takedown contact, and a
  repeat-infringer policy. Without them there is no safe harbour. Cheap; do it
  before launch.

None of that is review, and none of it scales with app count.

### CSP bounds exfiltration; it does not prevent it

The enforcement point is the **routing worker**, as response headers on the app
origin — there is no iframe to carry a `<meta>` CSP, and the app's own document
must not be able to relax its own policy. Unlike Frieren's opaque frame, a standalone
top-level page also has ambient browser APIs. A restrictive `Permissions-Policy` must
disable camera, microphone, geolocation, USB/serial/Bluetooth, payment, and other device
surfaces not represented by declared capabilities; otherwise the capability list is not
the app's complete reach.

`connect-src` alone is not the network boundary. The minimum is `connect-src`,
**`form-action`**, `img-src` and `style-src` — a bare `<form action="https://…">`
POSTs anywhere under `connect-src` alone, and a CSS or `img` URL carries data out
just as well.

`script-src 'self'` suffices without an inline importmap now that the platform serves no
framework bytes (#373). **`style-src 'self'` does not yet suffice**: `kernelHost`, App
Code CSS imports, and `injectStyle` all fold app CSS into `gui.js` and create runtime
`<style>` elements; React apps may also use style attributes. v1 must either allow the
necessary inline styles while keeping image/font/style fetches closed, propagate a nonce
through every style path, or emit same-origin CSS artifacts. The platform stylesheet
itself remains a same-origin `<link>`.

And **navigation cannot be blocked**: `location = 'https://…?d=…'`,
`window.open`, or a link click all exfiltrate, and the proposed `navigate-to`
directive was dropped and does not exist in browsers. A top-level page can always
leave with data in the URL.

State the guarantee accordingly: **an app's own data cannot be prevented from
leaving; what is bounded is which data it has.** That was always the actual
claim, and it is the one origin isolation delivers.

Note also that v1's tight CSP is affordable only because there is no `net`
capability. That advantage is spent the day `net` ships.

## The installed manifest is the app spec

Landed in #379. Entry fields keep their existing meaning — always relative bundle
paths. A store-backed install enriches the authored manifest with source and integrity
metadata:

```jsonc
{
	"app": "app.js",
	"gui": "gui.js",
	"icon": "icon.png",
	"baseUrl": "https://alice-notes.justapps.run/v/1.2.0/",
	"hash": "<whole-app fingerprint>",
	"files": {
		"gui.js": "sha256-<digest>",
		"icon.png": "sha256-<digest>"
	}
}
```

The **store/installer writes** `baseUrl`, `hash` and `files`; a published app cannot
name its own source. `baseUrl` alone selects one of two shapes:

- **absent — copied app.** Every bundle file lives under `/applications/<id>/` and
  replicates. App Code drafts, zip installs, Mac's packaged built-ins, and today's
  jsDelivr community installs use this shape because the volume is their durable copy.
- **present — hosted app.** `/applications/<id>/` holds the installed `manifest.json`
  and `app.js`. Every other bundle file is mounted from `baseUrl` and cached by the
  HOST, not the volume — in frieren, the service worker's `justapps` Cache API bucket.

The reducer is deliberately never mounted. The DO has no asset fetcher and must be able
to run an installed app after the origin has stopped serving that release. #373 keeps
this durable half small and framework-free; `gui.js` carries any framework and is the
part worth keeping out of sync.

`hash` fingerprints every catalog path and digest, including the authored manifest and
reducer. `files` carries the per-file pins for the mounted half. On read, the kernel:

1. fetches `<baseUrl>/<path>`, which the host may satisfy from its own cache;
2. verifies the returned bytes against the installed pin; and
3. evicts that exact cache entry on a mismatch, so the next read refetches.

The kernel makes the same call either way — it does not know whether a byte came from
the network or the cache, which is what keeps the integrity check unconditional.
Because a release URL is immutable, stale bytes from another release are simply never
addressed. Uninstall evicts the app's pinned URLs before trashing the record, since the
record is the only thing that can name them; growth is otherwise bounded by the service
worker's own expiration. All install staging lives under `/private/tmp/app-installs`, so
temporary bytes never churn sync either.

Reconciliation checks only the files that belong in the volume — the manifest record
and reducer for a hosted app. A missing mounted file repairs itself on read. A change to
`baseUrl` triggers reinstall even when version and whole-app hash are unchanged, covering
copied → hosted, hosted → copied, and origin → origin moves without a migration marker or
version bump.

Built-ins are the first user of this model today: Frieren gives each catalog entry a
same-origin, version-pathed `baseUrl`. Community apps still copy from jsDelivr; locally
created and packaged apps still copy in full. This is a consequence of whether a store
can promise a stable upstream, not a first-party residency flag.

A **base**, not a file URL, remains forward-compatible across two desktop
implementations:

1. **URL as bytes** *(implemented)* — Frieren fetches and verifies mounted files, then
   injects `gui.js` into the existing opaque-origin frame. Standalone gets a real origin;
   embedded does not, so routing and service workers work standalone only.
2. **URL as page** *(later)* — Frieren frames the hosted page cross-origin; that page runs
   its own kernel and Frieren injects `fs` and capabilities. Real origin in both contexts.

Authors keep relative entries either way, so bytes → page needs no republishing.
Built-ins may use a same-origin absolute path. An external base must be HTTPS,
version-pinned (never `latest`), CORS-readable, and allowed by Frieren's response policy.
Those URL constraints still need enforcement at the store boundary before arbitrary
self-hosted origins are accepted.

## The runtime is a host adapter

Dropping the iframe removes a trust boundary, not the runtime: dispatch queue,
state store, commands, subscriptions and procedures are all still needed. But
they are not new — `kernel()` is already parameterized by `sandbox: GetSandbox`,
so the standalone case is a `GetSandbox` that does not isolate:

```ts
kernel({ fs: volume(idbStore(dbName)), sandbox, capabilities })
```

plus a boot that mounts `gui.js` against a client — on the order of 150–200 lines.
(`host.ts` is 316, but most of it is stage lifecycle and minimize/restore that
one-app-one-window does not have.)

Three things that boot has to do, none of them obvious from the line above:

- **Self-install and upgrade.** `loadSandbox` still resolves
  `/applications/<id>/app.js`, so the shell first decodes its own hostname to the app id,
  resolves that id's active immutable release, and atomically installs its app spec into
  the local IDB volume: record + reducer durable, browser files mounted. Repeat boots
  compare the installed fingerprint before doing work.
- **Inject the platform stylesheet.** The app document is its own document with
  its own UA stylesheet — nothing about appearance carries over. The shell
  `<link>`s `@justfiles/design/mac.css` from a runner-served URL: element defaults
  wrapped in `:where()`, so plain `<button>`/`<input>` look native and any app
  rule wins without a fight. **Served, never pinned into the artifact**, so a
  platform restyle reaches every published app with no republish.
- **Declare the capability set.** v1 offers `volume` (the app's own chroot) and
  `notify`. `ai` needs an account and is therefore unavailable;
  `email`/`calendar`/`settings`/`devkit` are never grantable. An app declaring
  any of them gets `CAPABILITY_UNAVAILABLE`, which is the same degradation
  `docs/app.md` already documents per host — hosted is one more column in that
  table, not a new mechanism.

**Frame it as a third host adapter, never as "a runtime for hosted apps."** The
latter drifts into a second implementation of the same semantics.

**Keep the reducer in a Worker** even with nothing to isolate. In-page it would
have `document`, authors would reach for it, and the app would break later in the
desktop and on Mac where the reducer is genuinely headless. On a real origin this
is a plain module Worker with a static import — `sandboxWorkerSource(url, 'web')`
— with none of Topology B's classic-worker-from-blob contortion, which existed
only because module workers will not load from a blob in an opaque-origin frame.

**Pin the runtime into the artifact.** Emit it from the same build as
`app.js`/`gui.js`, on the app's own origin. A shared hosted `runtime.js` would
make every deployed app depend on live platform infra, skew versions, and hand us
silent rewrite power over everything already published. There is no shared-cache
argument against pinning — the HTTP cache is partitioned by top-level site.

**No framework bytes, ever** (#373). Each app bundles its own framework into
`gui.js`; the platform ships none. This used to be a React-shaped exception — the
desktop externalised five `reactExternals` specifiers and resolved them through an
importmap to frieren's `/vendor/*.js` — and dropping it removes the last thing the
app origin would have had to serve beyond the artifact itself.

The same cache-partitioning argument that permits pinning is why sharing could
never have worked here: two app origins cannot share a fetch even from an
identical URL, so an optimization that pays for itself on frieren's single origin
pays nothing across per-app origins. And it does not generalise — an author
writing Svelte, Solid, or plain DOM pays full price regardless, and vendoring
N frameworks × M versions is not a business we are in.

Consequences for the shell, all simplifications: **no vendor files, no importmap,
and therefore no inline-script exception in the CSP.** The minimum static surface is
the installed app's entries and assets, the pinned runtime, the shell document, and one
host stylesheet.

**Multi-tab remains unsolved.** `kernel.reload(appId)` plus
`volume.watch('/state/<id>.json')` notices another writer after it commits, but it does
not serialize two transitions that started from the same state; one tab can still
overwrite the other. v1 needs a single-writer mechanism (for example a `SharedWorker`,
a Web Locks leader, or one-active-tab enforcement), not just reload-after-write.

## What the desktop and the DO actually need

Verified in #379: **nothing server-side reads GUI bytes.** The browser reads and warms
them; the DO reads the installed manifest and reducer only.

A hosted install therefore has this shape:

```text
/applications/<id>/manifest.json       synced installed record
/applications/<id>/app.js              synced reducer for browser and DO kernels
caches.open('justapps')                browser-local GUI, icon, and assets
```

The DO deliberately has no `fetchAsset`. Keeping `app.js` durable prevents an installed
record from becoming agent-inoperable when an old release disappears from the current
deploy. Missing or corrupt reducer bytes trigger reconcile; missing or stale mounted
bytes trigger a verified refetch in the browser.

This is already how Frieren's built-ins install. It absorbs #373's framework cost:
React now lives inside each React app's `gui.js`, but those built-in GUIs no longer enter
the synced volume or metered DO storage. The deployment's service worker precaches their
immutable release URLs, and hydration warms the private mount, preserving offline launch.

A store with no durable mount source still copies every file into `/applications`.
That currently includes App Code drafts, zip installs, Mac's packaged built-ins, and
community apps fetched from jsDelivr. Hosted publishing is the point at which community
apps can switch shapes safely.

## Naming and domains

Two registrable domains. Arbitrary user content must not share one with the auth
origin: a phishing page next to the sign-in page means one Safe Browsing flag
takes down the platform, which is why GitHub uses `githubusercontent.com` and
Vercel `vercel.app`.

**One label, immutable.** A wildcard certificate matches exactly one label, so
`app.user.justapps.run` needs paid multi-level certs or per-user issuance (~50
new authors/week under Let's Encrypt); Cloudflare Universal SSL covers one level
free. And the label is storage identity — changing it orphans every anonymous
user's IndexedDB — so renames move the platform pointer, never the origin.

**The version goes in the path, never in the label** — origin
`alice-notes.justapps.run`, `baseUrl` `…/v/1.2.0/`. This is what lets a user's data
survive an upgrade, and it follows directly from the label being storage
identity. Putting the version in the hostname would orphan every anonymous user's
IndexedDB on every release.

**The label is derived from the app id, not allocated.** App ids are
`<publisher>.<app>` and the dotted id is inlined into one DNS label using
[IPFS's DNSLink encoding](https://specs.ipfs.tech/http-gateways/subdomain-gateway/) —
every `-` becomes `--`, then every `.` becomes `-`, so `alice.notes` is
`alice-notes.justapps.run`. [`catalog.md`](./catalog.md#the-id-is-the-hostname) carries the
full rationale, the canonical-form rule a decoder has to enforce, and why the hyphen is the
escaped character rather than the dot.

This replaces the first-come-first-served slug registry this document previously
specified, and deletes a surprising amount with it: no second namespace, no
allocation chokepoint, no land grab, no separate slug tombstone ledger, and no
`APP_STORE_PLAN.md`-style first-claim-wins binding to enforce in two directions.
The app id is already globally unique, publisher-scoped and dispute-free, and the
catalog's filesystem-as-uniqueness-constraint now enforces hostname uniqueness for
free. Injectivity is what makes that safe: the decoder rejects any label that is
not the one canonical encoding of an id, because two labels reaching one app would
be two origins over a single store.

Two consequences worth stating. **The platform keeps the entire hyphen-free label
space** — every id has at least two segments, so every app label has at least one
hyphen, and `www`, `api`, `store` and `abuse` can never be claimed by an app with
no denylist to maintain. And **the 63-character DNS label limit binds the app id**,
which the catalog validator enforces at submission time rather than letting a
merged entry fail at request time.

What is given up is a bare one-word hostname. `draw.justapps.run` is a globally
scarce name, and handing them out first-come-first-served is precisely the dispute
apparatus reverse-DNS ids were adopted to avoid; it would have re-entered through
the hosting door. `alice-notes.justapps.run` is the price, and it is cheap. If a
shorter form is ever wanted, Cloudflare for SaaS custom hostnames buy
`notes.alice.justapps.run` at roughly $0.10/hostname/month past the free 100 —
worth pricing before the first app ships, since moving between the two is an origin
change and therefore not free.

The pretty pointer is a **302 on the content domain** — `justapps.run/<user>/<app>`
— never on the platform domain, because redirectors inherit the reputation of
what they point at. The browser must end up showing the app origin: that address
bar is what gives per-app permission scoping, per-app PWA install, and a flagged
app burning only its own hostname. Proxying the content under a path would put
every app back on one shared origin; a full-page iframe wrapper would forfeit URL
ownership and make phishing worse. `justapps.com/<user>/<app>` stays a store page
that describes an app and never launches one.

**PSL**: submit the real content domain early because it is slow — the maintainers
disclaim any timeline and browsers bundle a snapshot per release. `localStorage` and
IndexedDB are origin-keyed without it, but that is not the whole boundary: hostile app
code can set `Domain=justapps.run` cookies and sibling app origins are same-site until
the domain is listed. The earlier claim that "nothing here puts cookies on the content
domain" ignored app code itself. Treat PSL availability as a v1 launch dependency unless
cookie tossing and same-site coupling are explicitly accepted and tested.

## Self-hosted GUIs

A store-supplied `baseUrl` need not be ours, but this is later scope. Two things get
conflated:

**Author's domain, our infrastructure** — `myawesomeapp.com` CNAMEs to us. We still
serve immutable bytes and control the routing worker. This is operationally ordinary,
but choosing or changing that domain changes the browser origin and therefore strands
anonymous IndexedDB unless there is an explicit migration/export path.

**Author's domain, author's infrastructure** — the registry records a version-pinned URL
and the browser fetches from it. The installed app spec already carries per-file digests,
so a byte swap fails closed and an update goes through normal reinstall and capability
escalation. The app cannot write `baseUrl` itself; the store creates the installed spec
from a validated publication.

That preserves code integrity, but not availability. The author's host must keep every
published version readable with CORS forever, or the platform must mirror it. Before this
mode ships, enforce external-URL policy at the store boundary, decide retention/fallback,
and decide how Frieren's CSP permits foreign fetches without turning its host page into a
general network client.

## Later: going online

Turning a standalone app online is small **client-side**: swap
`volume(idbStore(…))` for `synced({ local, remote })` in the shell. The kernel,
the app, and the GUI are untouched.

The server side is the real work and the real risk gate. The wire IS the storage
seam — `storeApi` is six routes over `Store` — so there is no separate protocol
to scope, but there is also no path to filter on: a row's location is
`(parent, name)`, and a prefix is something a scoped route would have to resolve
for itself. **The sharp edge is blob-by-hash**: content addressing makes a hash a
capability, and `GET /blob/:hash` is position-blind, so a scoped client that
learns a hash reads that content regardless of scope. Scoped blob reads must be
**reachability-gated** — is this hash named by a row under the granted subtree? —
or the scope is decorative. The alternative the store model opens up is to give
the app its own `Store` and mount it, so there is no subtree to scope at all.

The credential is a token scoped to `/data/<app-id>` for one app and one user,
enforced by the DO. That, not a browser realm, is the boundary: a fully malicious
app holding it can corrupt only data it already owned.

Consequence worth stating once: **anything the client kernel enforces is
advisory; anything the server enforces is real.** Harmless for the chroot,
decisive for capabilities with real-world cost — `ai` metering, rate limits, and
any `net` allowlist must all be checked server-side.

`email`, `calendar`, `settings` and `devkit` are never grantable to hosted apps.

## Gaps before v1

The architecture is small; the launch contract is not finished. These are requirements,
not speculative platform features:

1. **Publishing is authenticated even when visiting is anonymous.** The publisher identity
   and ownership model is settled — [`catalog.md`](./catalog.md)'s `<publisher>.<app>` ids, proven
   against a GitHub login — and the hostname follows from the id, so there is no separate
   name to own. What remains is the publication path: the server — never the submitted
   manifest — must assign `baseUrl`, recompute every digest, validate entry paths and
   capabilities, enforce file/count/size quotas, write immutable R2 objects, and only
   then atomically flip the app's active-version pointer. Reconcile this with
   `APP_STORE_PLAN.md`'s npm package ↔ app-id binding so the same id cannot be
   claimed independently through two publication channels.
2. **Enforce the source-metadata trust boundary in code.** The store installer overwrites
   `baseUrl`, `hash`, and `files` today, but the lower-level kernel can still accept those
   fields from another bundle path and can read an unpinned mounted file. A zip or draft
   install must have those fields stripped/rejected; a trusted hosted install must pin
   every mounted entry and asset. Otherwise “the app cannot choose its source” is a
   convention, not a guarantee.
3. **A hostname is never reassigned.** Unpublish, account deletion, and a killed app must
   tombstone the app id permanently — which is already the catalog's rule, since an entry
   is never deleted, only given a `removed` or `renamed` status. Because the hostname is
   derived, that one tombstone covers both. Reusing an origin would give a new publisher
   the old visitors' IndexedDB, service worker, browser permissions, and bookmarks. A
   display rename can move a platform pointer; it cannot recycle or move the storage
   identity. Note the corollary: an *id* rename does move the origin, and no alias map
   reaches an anonymous visitor's IndexedDB — so a rename is a data-loss event for a live
   hosted app, and the policy for that is still open in [`catalog.md`](./catalog.md).
4. **The service-worker takedown path needs an adversarial design and browser test.** A
   routing-worker `410` plus `Clear-Site-Data` is ineffective while an already-installed
   app worker serves the navigation without touching the network. Keep the root-scope
   worker platform-owned, serve app-controlled scripts only below immutable version
   paths without scope widening, and prove that an already-controlled tab transitions
   after the kill once it is online. Document that a fully offline client cannot learn
   the kill. Also decide whether takedown destroys user data: `Clear-Site-Data: "storage"`
   removes IndexedDB as well as the worker.
5. **Write the exact response policy, then test escape channels.** Start from
   `default-src 'none'`; explicitly decide script/worker/style/image/font/media/frame,
   `connect-src`, `form-action`, `base-uri`, `object-src`, and `frame-ancestors`, plus a
   deny-by-default `Permissions-Policy`. Verify framework-generated styles still render,
   reducer Workers boot, device APIs are unavailable, forms/images/CSS/WebRTC cannot
   beacon, and the accepted top-level-navigation leak is the only intentional network
   escape.
6. **Choose a single-writer rule for IndexedDB state.** Watching and reloading detects a
   peer after the fact but does not prevent lost updates. Multi-tab must either coordinate
   a leader or be explicitly rejected in v1.
7. **State the durability limits of anonymous local data.** Handle quota failures, request
   persistent storage where available, and provide export/reset before claiming more than
   “this browser stores the data.” Clearing site data, browser eviction, and changing to a
   custom domain otherwise look like unexplained data loss.
8. **Acquire the real content domain and start PSL work before public launch.** The
   placeholder cannot be routed, certified, reputation-monitored, or submitted to the
   PSL, and the sibling-cookie boundary cannot be tested without it.

Self-hosted origins, custom domains, account sync, and `net` should remain later work;
none is needed to close these v1 gaps.

## Prior art: Puter

[Puter](https://github.com/heyputer/puter) (AGPL, ~43k stars) is the closest
analogue in production — a web desktop with a filesystem, a windowing shell, and
an App Center carrying real third-party apps. Findings below are from reading the
source, not the marketing.

### Their strategy: publishing is open, *listing* is gated

`src/dev-center/js/apps.js` carries three independent approval flags:

```js
app.approved_for_listing            // appears in the App Center
app.approved_for_opening_items      // may be a file-type handler
app.approved_for_incentive_program  // may monetize
```

Anyone can create an app, get a subdomain and share the URL, unreviewed. Review
applies only to **listing**, to **privileged integration** (receiving other apps'
files), and to **money** — and it is product-quality review (completeness,
category, description), not security review.

That is the same line this document draws between what consent closes and what it
does not, applied to surfaces: a direct link is the user's choice, but a listing
is *our recommendation*, monetization is *our handling of money*, and file
handling is *reaching past your own data*. **Gate what the platform asserts, not
what it hosts.**

Directly applicable: an app declaring a path scope (`['/notes']`) rather than its
private chroot is the analogue of `approved_for_opening_items` — a listing-time
question, not a publish-time one.

### Independent convergence on the boundary model

- **Per-app subdomain on a separate hosting domain** — `launch_app.js:427`,
  `https://${name}.${app_domain}/index.html`, with `private_app_hosting_domain`
  and `static_hosting_domain` (`puter.site`) configured apart from the GUI domain.
- **A per-app scoped token, not the session token** —
  `fetchUserAppTokenForLaunch({ appUid })`, which **fails closed**: *"App launch
  blocked because app token could not be acquired."*
- **A per-app data directory** — `/<username>/AppData/<app-uid>/`.
- **A first-party escape hatch** — `godmode` apps receive `window.auth_token`,
  the super token; our `systemAllowlist`.
- **Real-origin iframe keeping `allow-same-origin`**, with `UIWindow.js:443`
  giving the same reason recorded here for why that is safe cross-origin but not
  under `srcdoc`.

Reached separately, by a project with third-party apps actually in production.

### Where we are deliberately stricter

- **They pass the token in the URL query string.** `frieren` rejected that
  explicitly — `apps/frieren/worker/index.ts` moved the caps socket to a `bearer.<token>`
  subprotocol because query-string credentials leak into proxy and access logs
  and browser history. Scoping limits the blast radius; it does not stop the leak.
- **Permissive sandbox flags** — `allow-popups-to-escape-sandbox` and
  `allow-top-navigation-by-user-activation`.
- **Not on the PSL.** Checked against the list directly: no entry contains
  "puter". This proves the product can operate with a weaker cookie/site boundary; it
  does not prove that boundary is acceptable here.

## Delivery status and build order

**Done foundations**

- #373: apps bundle their own framework; hosts inject only the platform stylesheet.
- #376/#379: the installed manifest is an integrity-pinned app spec; Frieren's built-ins
  mount GUI bytes through the service worker cache while the record and reducer sync.
**Prototyped, on an unmerged branch and not in the tree**

- Host routing and deployment configuration: a one-label host decodes to an app id, and
  anything that is not a canonical encoding is refused. It does not yet run a kernel.
- The registry pipeline of [`registry.md`](./registry.md) — catalog snapshot, release
  resolution, import into R2, and version-pinned serving. Step 1 below is the half of that
  work this document is waiting on; publishing and approval are not part of the prototype.

**Remaining order**

1. **Registry and publication contract** — immutable bundles in R2, authenticated
   publishing against catalog-proven ids, limits and validation, an atomic active
   version pointer, and `hostedAppStore()` in `apps/frieren/shared/appstore.ts`. Install one
   published app into the desktop from a link. No slug allocation step: the hostname is
   derived, and the catalog entry is already the permanent tombstone.
2. **One app origin, anonymous** — complete the routing worker, static shell, IDB volume,
   offline/takedown worker, and third host adapter with its Worker-backed `GetSandbox`.
   Add the single-writer rule and exact response policy here.
3. **Abuse and launch hardening** — kill/410/clear flow, `noindex`, abuse and DMCA
   contacts, repeat-infringer policy, PSL, storage/quota UX, observability, and browser
   smoke tests against a hostile bundle.
4. **Publish from the Code app** — `devkit.publish` sends the packed bundle through the
   registry validation path. Write an app in the browser, get a URL. An internal demo can
   precede step 3; public publishing cannot.
5. **Going online** — scoped sync with reachability-gated blob reads, token minting,
   consent, and the first-sync merge rule. Adversarial tests: a hash outside the prefix,
   escaping push paths, and a token replayed against another app's subtree.

## Decision log

**Settled**

1. Two registrable domains; the 302 lives on the content one; the platform hosts
   a store page that never launches an app.
2. Per-app origins, one label, immutable. The label is **derived** from the
   `<publisher>.<app>` id by DNSLink inlining, never allocated — no slug registry,
   and the platform keeps every hyphen-free label.
3. PSL submission starts early and is a public-v1 dependency unless the weaker sibling
   cookie/site boundary is explicitly accepted.
4. The installer enriches the manifest with `baseUrl`, whole-app `hash`, and mounted-file
   pins; entry fields stay relative. URL-as-bytes first, URL-as-page later, same app spec.
5. Hosted apps sync `manifest.json` + `app.js`; other files mount through the host cache.
6. The runtime is a third `GetSandbox`, pinned into each artifact, with the
   reducer in a Worker.
7. v1 visitors are anonymous; publishers authenticate, but there is **no review gate on
   publishing**, per the pi posture. A store listing is a separate surface that may be
   gated later.
8. No build service.
9. Every mounted file is integrity-pinned in the installed record; foreign hosting also
   needs URL policy, CORS and an availability contract before it is enabled.
10. Online later: the boundary is a server-enforced token scope.
11. **The platform serves no framework bytes** — each app bundles its own
    framework into `gui.js`, and the reducer stays framework-free (#373).
12. **The platform stylesheet is host-injected at runtime**, never pinned into an
    artifact, so a restyle reaches published apps with no republish.
13. Built-ins are hosted today; community, locally-authored, zip, and Mac-packaged apps
    remain copied until their store can promise a durable mount source.

**Open**

1. **The app surface** — portable-only vs host-adaptive routing, i.e. whether the
   desktop ever moves to URL-as-page. Parked; standalone does not depend on it.
2. The single-writer mechanism for standalone multi-tab use. Needed before public v1.
3. The first-sync merge rule when both the local volume and the account subtree hold
   data. Needed before online sync.
4. Whether a `net` capability ships, and where its host implementation runs.
   Server-side is the only version that escapes CORS, and that makes it a proxy needing
   SSRF guards.
5. Whether author-hosted origins and custom domains are supported, including URL policy,
   retention, CSP/CORS, and anonymous-data migration.

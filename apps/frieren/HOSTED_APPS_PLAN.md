# Hosted apps

> Status: **design, converged; not started.**
>
> Let an author publish one app and get a URL anyone can open — no infra, no
> account required of the visitor. An **addition** to the local-first app system,
> not a replacement.
>
> `justapps.com` / `justapps.run` are placeholders.

## The shape

```text
justapps.com          platform: accounts, publishing, store pages, docs
<slug>.justapps.run   one origin per app — a normal web page
```

- **An app is a normal website** at its own origin. Routing, History, caching,
  service worker all behave normally.
- **Its data is its own** — a `@justfiles/fs` volume over IndexedDB on that
  origin. Not the desktop volume. No account needed.
- **The kernel still runs**, in the page, with the reducer in a Worker. It is
  `packages/app` unchanged behind a third host adapter.
- **The same bundle runs in the desktop**, selected by one manifest field.
- **No build service.** The author's machine or browser compiles; we store and
  serve immutable bytes.

The product is R2 + a routing worker + a static shell + a slug table. No per-app
compute, no build farm, no second database.

## v1 is anonymous-only

The scope that threatened to balloon was never the architecture — it was the
moderation apparatus. Two cuts keep this at indie scale:

**No account sync in v1.** Hosted apps store data in browser-local IndexedDB,
full stop. That removes the scoped sync endpoint, reachability-gated blob reads,
token minting, the consent screen, and the first-sync merge — most of the
remaining work and all of the security-critical work. The pitch survives intact,
and it is honest: *this app stores data in your browser*.

**No gate on publishing**, per `APP_STORE_PLAN.md`'s existing posture and pi's:
apps run with the access they declare, users install at their own risk, we do not
review. Keep `abuse@`, a DMCA agent, and a kill switch. Drop screening,
confusables checks, publish-time detection, and preview domains until something
forces them.

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
- **Unpublish is one flip.** Bundles are immutable behind the routing worker, so
  removal is instant and global. Serve a **410** on a killed hostname rather than
  anything app-shaped, so a re-crawl sees remediation. Response time is what Safe
  Browsing measures.
- **The service-worker trap**: a registered SW keeps serving from cache to
  returning visitors after unpublish. The kill path must serve
  `Clear-Site-Data: "storage"` and a self-unregistering SW, or the takedown is
  not one.
- **DMCA §512(c) safe harbour is conditional** — a designated agent registered
  with the US Copyright Office, a published takedown contact, and a
  repeat-infringer policy. Without them there is no safe harbour. Cheap; do it
  before launch.

None of that is review, and none of it scales with app count.

### CSP bounds exfiltration; it does not prevent it

The enforcement point is the **routing worker**, as response headers on the app
origin — there is no iframe to carry a `<meta>` CSP, and the app's own document
must not be able to relax its own policy.

`connect-src` alone is not the network boundary. The minimum is `connect-src`,
**`form-action`**, `img-src` and `style-src` — a bare `<form action="https://…">`
POSTs anywhere under `connect-src` alone, and a CSS or `img` URL carries data out
just as well.

And **navigation cannot be blocked**: `location = 'https://…?d=…'`,
`window.open`, or a link click all exfiltrate, and the proposed `navigate-to`
directive was dropped and does not exist in browsers. A top-level page can always
leave with data in the URL.

State the guarantee accordingly: **an app's own data cannot be prevented from
leaving; what is bounded is which data it has.** That was always the actual
claim, and it is the one origin isolation delivers.

Note also that v1's tight CSP is affordable only because there is no `net`
capability. That advantage is spent the day `net` ships.

## The manifest field that does the work

One new optional field, `AppManifest.baseUrl`. Entry fields keep their existing
meaning — always relative bundle paths, never anything else:

```jsonc
{
	"app": "app.js",     // always a relative bundle path
	"gui": "gui.js",     // always a relative bundle path
	"icon": "icon.png",  // always a relative bundle path
	"baseUrl": "https://notes.justapps.run/v/1.2.0/"   // optional
}
```

`baseUrl` says where the **browser half** resolves from:

- **absent** → everything resolves from `/applications/<id>/` in the volume.
  Today's behaviour, unchanged. App-code drafts and zip installs are untouched,
  which they need to be anyway.
- **present** → `gui`, `icon` and `include` resolve against the base; only
  `manifest.json` + `app.js` live in the volume.

This is `<base href>` / `publicPath` / `homepage`: **entries are relative,
resolution is separate.** The one rule that needs writing down is that the base
does not apply uniformly — **`app` is always volume-resident**, because the DO
needs it to run the app headlessly for the agent.

Not `host` (that word already means the runtime — `kernelHost`, "host
capabilities" — throughout `docs/app.md`), and not `origin` (this document uses
it in the security sense, and the value carries a version path, so it is not one).

Call sites that must learn about it:

- `app.ts:338` — the `AppManifest` interface itself.
- `kernel.app.ts:80` — the `missing gui entry` existence check; skip when
  `baseUrl` is set.
- `appstore.fs.ts:99` — enumerates manifest paths as bundle files; same.
- `hydrate.ts:11` — prefetches via `app.read()`; same.
- `host.ts:209` — the stage boot; the real change.

`baseUrl` rides the manifest spread in `kernel.app.ts:60` untouched, so it needs
no normalisation of its own.

Note `kernel.app.ts:64` is deliberately **not** on that list. An earlier draft
made `gui` itself polymorphic, which meant `safeBundlePath(manifest.gui)` would
silently mangle a URL (`https://a/b` → `https:/a/b`) — a quiet corruption rather
than a thrown error. Keeping `gui` a relative path removes that failure mode
instead of guarding against it.

A **base**, not a file URL, because it is forward-compatible across two
implementations:

1. **URL as bytes** *(v1)* — frieren fetches `<baseUrl>gui.js`, hash-verifies,
   and injects it into the existing srcdoc frame. One runtime in the desktop, no
   injection model. Standalone gets a real origin; embedded does not, so
   routing/SW work standalone only.

   **Cache the verified bytes under `/.state/`.** Otherwise the desktop loses
   offline for hosted apps — a network fetch at every stage boot, where a
   volume-installed app needs none. `/.state` is the right home:
   `PRIVATE_PREFIXES = ['/.state', '/private']` (`sync-replica.ts:525`) is a hard
   floor that `syncIgnore` can only widen, so the cache is device-local by
   construction — it never crosses the wire and never reaches metered DO storage.
   Keyed by version, since `baseUrl` is immutable.
2. **URL as page** *(later)* — frieren frames `<baseUrl>` cross-origin; that page
   runs its own kernel and frieren injects `fs` + `capabilities`. Real origin in
   both contexts.

Authors write the same manifest either way, so (1) → (2) needs no republishing.

Constraints: `https` only; a concrete version, never `latest` (a floating GUI
against an installed `app.js` reintroduces skew); frieren's CSP must permit
fetching — later framing — foreign origins.

## The runtime is a host adapter

Dropping the iframe removes a trust boundary, not the runtime: dispatch queue,
state store, commands, subscriptions and procedures are all still needed. But
they are not new — `kernel()` is already parameterized by `sandbox: GetSandbox`,
so the standalone case is a `GetSandbox` that does not isolate:

```ts
kernel({ fs: volume(idbStorage(dbName)), sandbox, capabilities })
```

plus a boot that mounts `gui.js` against a client — on the order of 150–200 lines.
(`host.ts` is 316, but most of it is stage lifecycle and minimize/restore that
one-app-one-window does not have.)

Three things that boot has to do, none of them obvious from the line above:

- **Self-install on first run.** `loadSandbox` resolves through
  `store.get(appId)`, which reads `/applications/<id>/app.js` from the volume —
  so the shell fetches its own bundle from its origin and `kernel.install()`s it
  into the local IDB volume. Idempotent and atomic, so it is safe every boot.
- **Supply React.** `gui.js` externalises all five `reactExternals` specifiers
  (`vite.ts:235`) and the desktop resolves them through an importmap to
  `/vendor/*.js`, emitted by frieren's build. Standalone has no host React: the
  app origin must serve those five files and install the same importmap. This is
  the first thing that breaks without it.
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

**Multi-tab** is the hazard this introduces: two tabs, one IndexedDB, two kernels,
both committing `/state/<id>.json`. The fix already exists for another reason —
`kernel.reload(appId)` plus `volume.watch('/state/<id>.json')`, which is how the
desktop absorbs the agent's server-side writes. A `SharedWorker` kernel is the
strict-correctness upgrade if multi-tab proves to matter.

## What the desktop and the DO actually need

Verified against the code: **nothing server-side reads GUI bytes.** The only
readers are `host.ts:209` and `hydrate.ts:11`, both browser-side. Icons are never
read from the volume either — the Dock renders them over HTTP (`hydrate.ts` says
so explicitly).

So for headless execution the DO needs exactly **`manifest.json` + `app.js`**:
the manifest to locate the reducer and to answer `kernel.list()` for the agent's
catalog, and `app.js` itself — which is already fully self-contained, since
`vite.ts` bundles the SDK in (a reducer Worker has no importmap) and React is
guarded out of every reducer-reachable module.

For a hosted app the volume therefore holds two files. That keeps hosted apps
first-class for the agent, and `gui.js` — the big one, against metered DO storage
— never lands there.

Two consequences:

- Install's `missing gui entry` check must honour `baseUrl`, or a hosted bundle
  carrying no `gui.js` throws.
- `reconcile`'s `filesPresentAndMatch` walks the catalog's `files[]`, so a
  catalog listing `gui.js` would decide the app is broken and reinstall it every
  checkpoint. Hosted catalog entries list only volume-resident files; the rest
  resolve against `baseUrl`, which is also where their integrity hashes come
  from for a self-hosted GUI — no new field.

This does **not** generalize to built-ins. The browser genuinely needs their
bytes, so a client-side `ignore` will not do, and `synced.ts` states the server
replica deliberately takes no `ignore` predicate.

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
`notes.justapps.run`, `baseUrl` `…/v/1.2.0/`. This is what lets a user's data
survive an upgrade, and it follows directly from the label being storage
identity. Putting the version in the hostname would orphan every anonymous user's
IndexedDB on every release.

**A first-come-first-served slug registry**, with an allocated id as the fallback.
Global FCFS means a land grab; that is an accepted cost of a memorable URL, and
allocation is the chokepoint where a brand/confusables screen goes if abuse ever
forces one. The registry authenticates the publisher, so it can simply *enforce*
the slug ↔ app-id binding in both directions and hold it stable across versions —
`APP_STORE_PLAN.md` needed elaborate first-claim-wins inference only because a
crawl cannot authenticate anyone.

The pretty pointer is a **302 on the content domain** — `justapps.run/<user>/<app>`
— never on the platform domain, because redirectors inherit the reputation of
what they point at. The browser must end up showing the app origin: that address
bar is what gives per-app permission scoping, per-app PWA install, and a flagged
app burning only its own hostname. Proxying the content under a path would put
every app back on one shared origin; a full-page iframe wrapper would forfeit URL
ownership and make phishing worse. `justapps.com/<user>/<app>` stays a store page
that describes an app and never launches one.

**PSL**: submit the content domain early because it is slow — the maintainers
disclaim any timeline and browsers bundle a snapshot per release — but it is
**not a launch blocker**. `localStorage` and IndexedDB are origin-keyed
regardless, so per-app data separation works unlisted. Listing buys cookie
scoping, same-site determination, and reduced blast radius; the first two are
entirely about cookies, and nothing here puts cookies on the content domain.

## Self-hosted GUIs

A `baseUrl` need not be ours. Two things get conflated and should not be:

**Author's domain, our infrastructure** — `myawesomeapp.com` CNAMEs to us. We
still serve the bytes and control immutability. Safe, ordinary, worth having.

**Author's domain, author's infrastructure** — we store a URL and fetch what is
there. This is a **different trust model**. Today bytes are hash-pinned at
install and changing them requires a version bump → `reconcile` → the
capability-escalation check. A live foreign URL bypasses all of it: a benign app
turns malicious silently, with no install event and no consent.

**Require an integrity hash in the manifest alongside the URL.** Bytes are then
pinned wherever they are hosted, a swap fails closed, and an update means a new
manifest version through the normal consent path. The author's server needs CORS
either way (cross-origin `fetch` and SRI both require it), and fails closed
without it.

Without the hash, "install once, consented" quietly becomes "trust this server
forever" — possibly acceptable under the pi posture, but it must be a deliberate
choice, not a side effect of allowing URLs.

## Later: going online

Turning a standalone app online is small **client-side**: swap
`volume(idbStorage(…))` for `synced({ local, remote })` in the shell. The kernel,
the app, and the GUI are untouched.

The server side is the real work and the real risk gate. `remoteSyncReplica`
calls only eight endpoints, none inode-based, and the sync wire is path-based —
so a prefix-scoped route is mostly filtering. **The sharp edge is blob-by-hash**:
content addressing makes a hash a capability, and `GET /blob/:hash` is
prefix-blind, so a scoped client that learns a hash reads that content regardless
of scope. Scoped blob reads must be **reachability-gated** — is this hash
referenced by an inode under the granted prefix? — or the scope is decorative.

The credential is a token scoped to `/data/<app-id>` for one app and one user,
enforced by the DO. That, not a browser realm, is the boundary: a fully malicious
app holding it can corrupt only data it already owned.

Consequence worth stating once: **anything the client kernel enforces is
advisory; anything the server enforces is real.** Harmless for the chroot,
decisive for capabilities with real-world cost — `ai` metering, rate limits, and
any `net` allowlist must all be checked server-side.

`email`, `calendar`, `settings` and `devkit` are never grantable to hosted apps.

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
  explicitly — `worker/index.ts` moved the caps socket to a `bearer.<token>`
  subprotocol because query-string credentials leak into proxy and access logs
  and browser history. Scoping limits the blast radius; it does not stop the leak.
- **Permissive sandbox flags** — `allow-popups-to-escape-sandbox` and
  `allow-top-navigation-by-user-activation`.
- **Not on the PSL.** Checked against the list directly: no entry contains
  "puter". Corroborates treating the submission as start-early, block-nothing.

## Build order

1. **Registry** — immutable bundles in R2, `hostedAppStore()` in
   `shared/appstore.ts`, slug table. Install one into the desktop from a link.
   Also a straight upgrade over `APP_STORE_PLAN.md` Step 3: a registry that
   authenticates the publisher *assigns* the id↔slug binding instead of inferring
   it from a crawl.
2. **`manifest.baseUrl`** — the four call sites above; frieren fetches and
   hash-verifies `<baseUrl>gui.js` into the existing srcdoc frame.
3. **One app origin, anonymous** — routing worker, static shell, own IDB volume,
   offline SW, and the third host adapter with its `Worker`-backed `GetSandbox`.
4. **Publish from the Code app** — `devkit.publish` POSTs the packed bundle.
   Write an app in the browser, get a URL. This is the demo, and it needs nothing
   from step 5.
5. **Going online** — the scoped sync endpoint with reachability-gated blob
   reads, token minting, consent, and the first-sync merge rule. Wants adversarial
   tests: a hash requested outside its prefix, a push with escaping paths, a token
   replayed against another app's subtree.

## Decision log

**Settled**

1. Two registrable domains; the 302 lives on the content one; the platform hosts
   a store page that never launches an app.
2. Per-app origins, one label, immutable, FCFS slug with an id fallback.
3. PSL submitted early, gating nothing.
4. `manifest.baseUrl` resolves the browser half; entry fields stay relative
   paths. URL-as-bytes first, URL-as-page later, same manifest.
5. Hosted apps keep only `manifest.json` + `app.js` in the volume.
6. The runtime is a third `GetSandbox`, pinned into each artifact, with the
   reducer in a Worker.
7. v1 is anonymous-only; **no gate on publishing**, per the pi posture — a store
   listing is a separate surface that may be gated later.
8. No build service.
9. Foreign-hosted GUIs require an integrity hash.
10. Online later: the boundary is a server-enforced token scope.

**Open**

1. **The app surface** — portable-only vs host-adaptive routing, i.e. whether the
   desktop ever moves to URL-as-page. Parked; nothing before step 3 depends on it.
2. The first-sync merge rule when both the local volume and the account subtree
   hold data. Needed before step 5.
3. Whether a `net` capability ships, and where its host implementation runs.
   Server-side is the only version that escapes CORS, and that makes it a proxy
   needing SSRF guards.

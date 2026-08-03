# Remote-hosted apps (justapps)

> Status: **design, converged; not started.** No code yet.
>
> Hosting for individual apps: an author writes an app against our spec, deploys
> in one click, and gets a URL they can share. Anyone can open it and use it
> without ever touching the desktop. This is an **addition** to the local-first
> app system, not a replacement.
>
> `justapps.com` and `justapp.run` are placeholders — see
> [Two domains](#two-domains-not-one) for why there are two.

## The shape, in one page

```text
justapps.com            the platform: accounts, publish, browse, docs, consent
<opaque>.justapp.run    one origin per app — a normal web page, no iframe
```

- **An app is a normal website.** Its own origin, its own document. Routing,
  History, caching, service worker, and the browser platform all behave
  normally. No sandboxed iframe, no `srcdoc`, no `postMessage` hop.
- **Its data is its own.** A `@justfiles/fs` volume over IndexedDB on that
  origin. Not the user's desktop volume. Anonymous visitors get this and need no
  account.
- **The kernel still runs — in the page.** Dropping the iframe removes a *trust*
  boundary, not the runtime: the dispatch queue, state store, command runtime,
  subscription reconciler and procedure runner are all still needed. They are
  `packages/app` unchanged, behind a third host adapter. See
  [The runtime is a host adapter](#the-runtime-is-a-host-adapter).
- **The reducer still runs in a Worker** — for discipline, not security.
- **Sign-in is opt-in and syncs one subtree.** The user may connect the app to
  their Kodama account, at which point that app's volume syncs into
  `/data/<app-id>` of their real volume — and nothing else.
- **The security boundary is the token's scope, not a browser realm.** See
  [Where the boundary goes](#where-the-boundary-goes).
- **No build service.** The author's machine (or their browser) compiles; the
  platform stores and serves immutable bytes.

The whole hosting product is therefore R2 + a routing worker + a static shell,
all immutable and edge-cacheable. No per-app compute, no build farm, no second
database.

## What the tree already decided

Four existing decisions constrain this, and they mostly point the same way.

**The kernel is host-agnostic.** `kernel({ fs, sandbox, capabilities })`
(`packages/app/kernel.ts`) knows nothing about where it runs. Two hosts already
build one over the same `app.js` bytes — the browser (Worker in a hidden
opaque-origin frame, `src/apps/sandbox.worker.ts`) and the user's Durable Object
(Worker Loader isolate, `globalOutbound: null`). A third host is a third
`GetSandbox` + `Capabilities` pair; the kernel needs no change.

**An app is already a directory of files.** `/applications/<id>/`,
`/state/<id>.json`, `/data/<id>/`. The install/verify/update machine
(`packages/app/appstore.ts` — per-file `sha256-` pinning, whole-app hash markers,
monotonic `reconcile`, `escalatesCapabilities`) is written and host-agnostic.

**The GUI is currently isolated harder than a web page** — opaque origin,
`connect-src 'none'`, authority limited to a `MessagePort`. This document
deliberately gives that up for hosted apps, and replaces it with something else;
that trade is the subject of [Where the boundary goes](#where-the-boundary-goes).

**`IFRAME_ISOLATION_PLAN.md` predicted the delivery model.** Its appendix
already nominates "URL-served apps from a dedicated app origin, backed by that
origin's own (backend-free) Service Worker for offline" as the future, with a
separate registrable domain if process isolation matters. This is that, arriving
early for a product reason.

The one decision that reverses: `APP_STORE_PLAN.md` chose **"the store is a
search index over npm — we never host, build, review, or distribute third-party
code."** Hosting bytes reverses the *hosting* half. It does **not** reverse the
*build* half — see [No build service](#no-build-service).

## Two domains, not one

Apps must not be paths on the platform domain (`justapps.com/user1/app1`), for
two independent reasons.

**One origin means one storage jar.** `localStorage`, IndexedDB, and `fetch`
credentials are per-origin, so every app could read every other app's data and
impersonate it. GitHub Pages, Glitch, StackBlitz and CodeSandbox all moved to
per-project hostnames for exactly this.

**Arbitrary user content must not share a registrable domain with the auth
origin.** Someone will publish a phishing page. If it sits next to the sign-in
page, one Safe Browsing flag takes down the platform. This is why GitHub serves
user content from `githubusercontent.com`, Vercel from `vercel.app`, CodeSandbox
from `csb.app`.

### Per-app, not per-user, and opaque

Per-*user* origins (`user1.justapps.com/app1`) would let one author's apps share
storage, which is defensible on its own terms. Three things decide against it,
none about app-to-app trust:

**Cookies are domain-scoped, not origin-scoped.** A page at
`user1.justapps.com` can set a cookie for `.justapps.com`, which is then sent to
every *other* user's subdomain and to `justapps.com` itself. Same-origin policy
does not stop this. It is why `github.io` is a separate domain **and** on the
**Public Suffix List** — the PSL entry is what makes `user1.github.io` and
`user2.github.io` distinct *sites* for cookies, `document.domain`, and storage
partitioning.

> **Submit the app-content domain to the PSL.** Free, applies to every scheme
> here, reduces blast radius when an app does get flagged, and takes weeks to
> land — so start it early.

**A wildcard certificate matches exactly one label.** `*.justapp.run` covers
`app1.justapp.run` but not `app1.user1.justapp.run`. Multi-level wildcards need
Cloudflare's paid Advanced Certificate Manager or per-user issuance — and Let's
Encrypt's 50-certs-per-registered-domain-per-week ceiling would cap new authors
at ~50/week. **Flat, single-label hostnames.**

**A human-readable hostname bakes identity into storage.** If the origin encodes
`user1`, a rename or an app transfer changes the origin and orphans that app's
IndexedDB. Same lesson `APP_STORE_PLAN.md` learned about manifest ids vs npm
names: the origin is a **stable opaque id**; `justapps.com/user1/app1` is the
pretty pointer that resolves to it.

## Where the boundary goes

Standalone, the page *is* the app. Nothing else is on it. So the sandboxed
iframe is not protecting other page content — the only thing it could protect is
**the user's Kodama data**, and that is the whole job.

Which means the boundary does not have to be a browser realm. It can be the
**scope of the credential**, enforced on the server:

> Sign-in mints a token that says: *user `<u>`, app `<id>`, may sync the subtree
> `/data/<id>`.* Nothing else.

A completely malicious app holding that token can corrupt exactly one thing: its
own data — which it could already do, because it owns its own IndexedDB. The
token becoming readable by app code stops mattering. **So the iframe has nothing
left to guard, and it goes.**

This is a better boundary than the realm was:

- It is enforced where we control it, rather than depending on realm semantics
  and CSP inheritance across browsers.
- It survives the app being an entirely normal website — routing, History, SW,
  caching, and the browser platform all work, which is the product.
- It composes: additional grants (`ai`, a `net` allowlist) become additional
  scopes on the same token, each independently revocable, each attributable in
  the meter.

### What this requires of the server

The scope must be enforced by the DO, not by a client-side chroot.
`resolveVolume` doing the `/data/<id>` chroot in the kernel is correct when the
kernel is trusted; here it is not.

Good news: `remoteSyncReplica` (`packages/core/src/fs.client.ts`) calls exactly
eight endpoints, and **none are inode-based**:

```text
GET      /                  handshake + lineage
GET      /path/changes      pull deltas
GET      /path/snapshot     scan
POST     /path/changes      push
GET|HEAD /blob/:hash
PUT      /blob/:hash
POST     /blobs/missing
POST     /reset
```

The sync wire is **path-based**, so a prefix-scoped route is mostly filtering and
rewriting paths on four endpoints. The `/inodes/*` and `/file/*` routes that
would leak simply are not mounted on it.

**The one real subtlety is blob-by-hash.** Content addressing means a hash *is* a
capability: `GET /blob/:hash` does not know which subtree a blob belongs to. A
scoped client that learns a hash from anywhere reads that content regardless of
prefix. Guessing is infeasible; known-plaintext is not — an app that knows a
file's exact bytes can compute its hash and confirm or fetch it.

> Blob reads on the scoped route must be **reachability-gated**: is this hash
> referenced by an inode under the granted prefix? Without that check the scope
> leaks and this design has no security property at all. It is the piece to be
> most careful about.

### What must NOT be grantable (v1)

`email` and `calendar` reach real user accounts and are not subtree-scopable —
keep them off hosted apps entirely. `ai` is grantable but bills the user's meter,
so it needs per-`(user, app)` attribution and a cap, or a malicious app burns
someone's budget. `settings` and `devkit` are first-party-only already.

### Consent hygiene

Consent lives on `justapps.com`, shows exact scopes, sets `frame-ancestors
'none'`, and never offers a broad scope. Otherwise an app renders its own
convincing "Sync to your Kodama account" button and drives a real flow requesting
more than the user thinks.

## The runtime is a host adapter

Removing the iframe removes a trust boundary, not the runtime. The reducer still
has to run, state still has to persist and carry its `seq`, commands and
subscriptions still have to be dispatched and reconciled. All of that is the
kernel, and it is still needed.

But it is not *new*. The kernel is already parameterized by `sandbox:
GetSandbox`, and the standalone case is a `GetSandbox` that does not isolate:

```ts
const inlineSandbox: GetSandbox = async ({ code }) => {
	const mod = await import(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))
	return {
		run: (msg, ctx) => mod.app.dispatch(msg, ctx),
		initialState: () => mod.app.initialState,
		actions: () => mod.app.actions ?? {},
		capabilities: () => mod.app.capabilities ?? {},
		subscriptions: (s) => mod.app.subscriptions?.(s) ?? [],
		runProcedure: (n, p, h) => mod.app.runProcedure(n, p, h)
	}
}
```

Everything else — the per-app dispatch queue, the state store, capability
resolution, the command runtime, the subscription reconciler, the procedure
runner — is `packages/app` unchanged. The standalone host is

```ts
kernel({ fs: volume(idbStorage(dbName)), sandbox, capabilities: standaloneCaps })
```

plus a boot that mounts `gui.js` against a client: on the order of 150–200 lines
of genuinely new code. (`src/apps/host.ts` is 316 lines, but most of it is stage
lifecycle, iframe management and minimize/restore that one-app-one-window does
not have.)

**Frame it as a third host adapter, not as a runtime.** A "runtime.js for hosted
apps" drifts from the desktop kernel and becomes a second implementation of the
same semantics. A third `GetSandbox` cannot.

### Pin the runtime into the artifact; do not serve it

Tempting shape: a `<script src="https://justapps.com/runtime.js">` every app
loads. Don't:

- it makes every deployed app **permanently dependent on live platform infra** —
  break it and every app breaks; take it down and every app is down. That is the
  opposite of immutable and edge-cacheable.
- **version skew**: an app built against v1 gets served v2.
- it is a supply-chain position — the ability to silently change the behaviour of
  every deployed app. Authors should not have to trust that, and we should not
  want it.

Emit it from the same build that emits `app.js`/`gui.js`, either inlined into the
boot module or as `/_rt/<hash>.js` on **the app's own origin**. Immutable with
the rest, offline for free, no skew.

There is no shared-cache argument against this: browsers partition the HTTP cache
by top-level site, so a runtime served from one common origin is re-fetched per
app anyway. The sharing that would justify the coupling does not exist.

### Keep the reducer in a Worker — for discipline, not security

Even with nothing to isolate, run the reducer in a plain `Worker`.
`sandboxWorkerSource(appUrl, 'web')` is already exactly this case (static import,
`self.postMessage`) and pairs with the existing `sandboxClient` — it is
`browserSandbox()` minus the iframe, so it costs almost nothing.

It buys three things:

1. **It keeps `app.ts` honest.** In-page, the reducer would have `document` and
   `window`. Authors will reach for them; the app will work standalone and then
   break in the desktop and on Mac, where the reducer is genuinely headless. That
   fails silently at authoring time and loudly much later.
2. **State crosses as structured clone**, so the GUI cannot reach in and mutate
   reducer state — the invariant the model rests on, preserved structurally
   rather than by convention.
3. Reduces stay off the main thread.

### Advisory vs real

Running the kernel in the page forces one rule to be explicit:

> **Anything the client kernel enforces is advisory. Anything the server enforces
> is real.** The kernel is a programming model, not a security mechanism.

Mostly harmless — an app bypassing its own chroot to reach its own IndexedDB is
not an attack. It bites on **capabilities with real-world cost**: with `ai`
granted, the app can skip the kernel and call the proxy with the token directly.
So metering, rate limits, and the `net` allowlist must all be enforced
server-side. The manifest declaration drives consent and what goes into the
token; the token drives enforcement. Any of that logic living in the in-page
kernel is decorative.

### Multi-tab is the hazard this introduces

Two tabs of the same app share one origin and one IndexedDB but get two kernels,
each with its own in-memory state cache, both committing `/state/<id>.json`.
That is a lost update — the exact hazard the per-app dispatch queue prevents
*within* one kernel. The desktop does not have it in this form.

The fix already exists, built for another reason: `kernel.reload(appId)` is there
precisely for "a host whose volume is ALSO written outside the kernel" (how the
desktop picks up the agent's server-side writes). Pair it with
`volume.watch('/state/<id>.json')`, which `host.ts` already does, and a second
tab converges on a foreign write with no new machinery.

For strict correctness, a Web Lock around the commit, or a `SharedWorker` hosting
one kernel for all tabs — the clean version, where the GUI reaches it over a
`MessagePort`, which is the transport that already exists. Ship dedicated Worker
+ watch/reload first; treat SharedWorker as the upgrade if multi-tab proves to
matter.

### Two build-path details that surface late

- **React is externalized today** (`reactExternals`) because the desktop supplies
  it by importmap. Standalone there is no host React, so the boot HTML must ship
  an importmap over same-origin vendor files — the `/vendor/*.js` frieren already
  serves. Small, but a real divergence between the two build targets.
- **Is the bundle installed into the volume, or just served?** Installing reuses
  `packages/app/appstore.ts` wholesale (including `reconcile` for updates);
  serving directly is cleaner and lets the SW own updates, but then
  `kernel.app(id)` needs a bundle backed by `fetch` rather than
  `/applications/<id>/`. Serving is the better fit, since the SW is already the
  update mechanism — but this decides whether `appstore.ts` participates at all,
  so settle it before writing the boot.

## No build service

Vercel takes code, runs a build farm, deploys. That is the expensive half of
Vercel and the worst liability in this space — `APP_STORE_PLAN.md` already ruled
out running untrusted builds, and that ruling survives.

It is also unnecessary here, because the app spec is three files and **we already
compile in the browser**: `packages/app-code` runs esbuild-wasm and `pack()`s a
draft to a zip today.

- **From the Code app** — compile in the browser, upload three files. One click,
  literally, with zero build infrastructure. This is the wedge: write an app in
  the browser, hit Publish, send someone a link. No repo, no npm account, no
  toolchain.
- **From a local repo** — `npx justapps deploy` runs the existing `kernelHost`
  Vite build locally and uploads `dist/`. The author's machine is the build farm,
  exactly as `npm publish` already works.

Git-push-to-deploy is the only feature that would need a build service, and it is
the one worth not having.

## Data, sync, and the one irreversible moment

There is no consolidation problem, because there is never a second durable store:

- **Anonymous** — a volume over IndexedDB on the app origin. Free, offline,
  isolated by origin, no account.
- **Connected** — the same local volume, now `synced()` against a scoped replica
  that lands in `/data/<app-id>` of the user's real volume. Same machinery as the
  desktop, pointed at a subtree.

The **first** sync after opt-in is the only hard moment: it merges two histories
that never shared a lineage — the anonymous local volume, and whatever is already
at `/data/<id>` in the account from using the app on the desktop.
`LOCAL_FIRST_PLAN.md` decision 7 already ruled *do not auto-merge*, and that
holds. It is far more tractable here than the profile case, because the scope is
one app's folder:

- account subtree empty → adopt local silently;
- non-empty → ask, offering keep-local / keep-account / keep-both-under-a-suffix.

Decide this before building the flow. It is the one step in the product a user
cannot undo.

## Network access

A `net` capability is planned, host-performed: the app never fetches directly,
the host makes the request and returns the response. Hosted apps should work the
same way. The open question is **where the host implementation runs**:

| implemented in | reach | cost |
| --- | --- | --- |
| the app page | **CORS-bound** — only APIs sending `Access-Control-Allow-Origin`, so not most third-party APIs and not the author's own backend until configured | none, but the capability looks broken to authors |
| a justapps worker | anything | you are running an **open HTTP proxy** |

Server-side is the only version that delivers the promise, so its guards come
with it: an author-declared host allowlist in the manifest (surfaced at consent;
it slots into `escalatesCapabilities`' token model as `net::<host>`),
private/link-local ranges denied **including after redirects** (SSRF, cloud
metadata endpoints), no cookie forwarding, no arbitrary `Host`/auth header
injection, and a per-app rate limit and egress budget.

Enforcement is an HTTP response header on the app origin — the routing worker
serves the document, so it sets `Content-Security-Policy: connect-src <allowlist>`.
That header is what makes "a normal website, still constrained" work without an
iframe.

## Not getting the domain banned

The hardest operational problem, and the one place the constrained app model is a
genuine structural advantage.

**Declared egress is the lever.** Phishing has to exfiltrate somewhere. On a
general host a deployed page fetches anywhere and there is nothing to inspect.
Here every host an app can reach is declared up front and proxied, so it can be
seen, scored, rate-limited, and revoked. The `net` allowlist is therefore not
really a security boundary once the app has its own origin and no broad
credential — **it is the primary anti-abuse instrument**, and it is why this is
tractable at a scale where it would not be for Vercel.

Beyond that, roughly in order of value:

- **Opaque per-app hostnames** — a flagged app burns its own hostname, not a
  shared path space.
- **PSL entry** — distinct registrable units reduce (not eliminate) the chance of
  a blanket parent-domain block.
- **`noindex` by default.** Phishing needs distribution. Let authors opt into
  indexing after account verification.
- **Cheap publish-time detections with real yield**: `<input type="password">` in
  an app declaring no `net` capability is nearly always phishing; brand
  names/logos near a login form; allowlisted hosts registered within 30 days.
- **Search Console + `abuse@` + fast takedown.** Response time is what Safe
  Browsing measures. Bundles are immutable behind a routing worker, so unpublish
  is instant and global.

**The trap: service workers outlive takedown.** A phishing app that registered a
SW keeps serving from cache to returning visitors after it is unpublished. The
unpublish path must serve `Clear-Site-Data: "storage"` and a self-unregistering
SW, or the takedown is not one.

### Liability posture

The platform-vendor read — AWS and Vercel are not liable for what customers
deploy, and do not meaningfully screen — is substantially correct, with three
qualifications:

- **The safe harbours are conditional.** DMCA §512(c) requires a designated agent
  *registered with the US Copyright Office* (a form, ~$6, renewed every 3 years),
  a published takedown contact, and a repeat-infringer termination policy.
  Without those there is no safe harbour. Do it before launch.
- **§230 has carve-outs and is US-only.** It does not cover federal criminal law,
  IP claims, or FOSTA-SESTA; CSAM reporting (18 U.S.C. §2258A) is a real
  obligation for a hosting provider. The EU DSA adds notice-and-action duties for
  EU users, with small-enterprise exemptions covering much of it early.
- **The real cost is reputational, and the model is Vercel's, not AWS's.** AWS
  customers mostly bring their own domains, so abuse does not pollute
  `amazonaws.com`. Here everyone lands on one wildcard, exactly like
  `*.vercel.app` — which does get corporate-filter blocklisted and periodically
  Safe-Browsing flagged, and which Vercel staffs an abuse team to manage.

Minimum viable posture: DMCA agent, `abuse@`, a takedown path, the denylist
already designed, and content on its own registrable domain. No screening.

## The open fork: two classes of app

Making hosted apps normal websites means authors will use routing, History,
service workers, `fetch`, and the browser permission surface. **An app that does
those things cannot run inside frieren's `srcdoc` iframe.** That is in direct
tension with "integrates with the desktop perfectly," and it is what the
simplification costs.

Three ways out. Pick deliberately rather than discovering it later:

1. **Two declared classes.** A manifest flag; the store shows which surfaces an
   app runs on. Cheap and honest, but splits the ecosystem.
2. **The desktop embeds hosted apps by URL** — a cross-origin `<iframe src>`
   instead of `srcdoc`, with a `MessagePort` handed in for capabilities. The same
   bundle then works both places (routing and SW work inside an iframe) and the
   app branches on whether it received a port. This is precisely the
   `DevkitPreview {kind:'url'}` convergence `IFRAME_ISOLATION_PLAN.md` predicted.
   Cost: an app loaded by URL is not offline the way a volume-installed app is,
   so the desktop ends up with two delivery modes.
3. Keep the app surface strictly identical and withhold the extra web platform
   from hosted apps — which forfeits the reason for hosting them this way.

**Read:** (2) is where this ends up; (1) is the right thing to ship first,
because it is a manifest field and a store badge rather than a second delivery
path in the desktop.

## Non-goals (first pass)

- **A build service.** See above. Not now, likely not ever.
- **Server-side reducers, shared/multiplayer state, webhooks, cron-per-app.** A
  shared state machine needs a single writer, which means an authoritative
  server-side kernel keyed by `(app id, room id)` rather than by user. That is a
  real product tier, and nothing here forecloses it — but it is not hosting, it
  is multiplayer, and it is the one thing that would introduce a second durable
  store.
- **Hosted apps reaching `email`/`calendar`.**
- Ratings, comments, featured lists, paid apps.
- Replacing the local app system. Local install, zip install, and app-code drafts
  keep working unchanged.

## Build order

1. **Registry.** Publish immutable bundles to R2; `hostedAppStore()` in
   `shared/appstore.ts` (a near-copy of `communityAppStore` minus the jsDelivr
   hop). Install one into the desktop from a link. No new origin, no new auth.
   This is also a straight upgrade over `APP_STORE_PLAN.md` Step 3 — a registry
   that authenticates the publisher at publish time *assigns* the id↔namespace
   binding instead of inferring it from a crawl.
2. **One app origin, anonymous only.** Routing worker, static shell, own IDB
   volume, offline SW — and the third host adapter: `kernel()` over the IDB
   volume with a `Worker`-backed non-isolating `GetSandbox`, plus the boot that
   mounts `gui.js`. Proves the bundle format, the delivery path, and that the
   runtime really is an adapter rather than a second kernel. No auth and no
   boundary yet, legitimately — there is no credential to protect.
3. **Publish from the Code app.** `devkit.publish` POSTs the packed bundle. This
   is the demo, and it needs nothing from step 4.
4. **The scoped sync endpoint.** The real risk gate: prefix-filtered path
   routes + **reachability-gated blob reads**, the scoped token, and the consent
   screen. Everything the security model rests on is in this step, so it wants
   adversarial tests (a client asking for a hash outside its prefix, a push with
   paths that escape it, a token replayed against another app's subtree).
5. **The first-sync merge decision UI**, then `net`, then the class-1 manifest
   flag.

Step 4 is the one that can be wrong in a way that matters.

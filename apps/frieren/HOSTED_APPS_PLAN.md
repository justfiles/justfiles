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
app--user.justapp.run   one origin per app — a normal web page, no iframe
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
- **Both delivery paths coexist, indistinguishably.** A URL is a *source*, not a
  runtime mode: in the desktop a hosted app installs from `hostedAppStore()` and
  is thereafter an ordinary installed app. See
  [Both delivery paths, one runtime](#both-delivery-paths-one-runtime).

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

### Per-app, not per-user

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

> **Submit the app-content domain to the PSL** — early, because it is slow. It
> is free and an afternoon of work, but it is **not a launch blocker**; see
> [Getting on the PSL](#getting-on-the-psl).

**A wildcard certificate matches exactly one label.** `*.justapp.run` covers
`app1.justapp.run` but not `app1.user1.justapp.run`. Multi-level wildcards need
Cloudflare's paid Advanced Certificate Manager or per-user issuance — and Let's
Encrypt's 50-certs-per-registered-domain-per-week ceiling would cap new authors
at ~50/week. **Flat, single-label hostnames.**

**The label must be immutable, whatever it says.** Origin *is* storage identity:
change the hostname and every anonymous user's IndexedDB for that app is
orphaned. (Signed-in users survive — their data is keyed by manifest id under
`/data/<app-id>` and re-syncs — so the harm lands entirely on anonymous
local-only users.) Same lesson `APP_STORE_PLAN.md` learned about manifest ids vs
npm names: the storage-bearing name must outlive the distribution name.

### The hostname scheme

```text
<app>--<user>.justapp.run     immutable origin, allocated at first publish
justapp.run/<user>/<app>      convenience redirect (302) — content domain, NOT the platform one
justapps.com/<user>/<app>     store page: describes the app, links to it, never launches it
```

**One level, readable, `--` separated, immutable, screened at allocation.** The
two constraints above (single-label for TLS; immutable for storage) are settled.
Readable-vs-opaque is the part that was genuinely open, and it trades UX against
abuse surface:

| | readable (`notes--user1`) | opaque (`k3f9q2mx`) |
| --- | --- | --- |
| the shared link | is the product | undercuts it; the redirect becomes canonical |
| clash | needs a separator rule | impossible by construction |
| after a rename | stale, cosmetic | n/a |
| deceptive hostname | `secure-paypal--x.justapp.run` is possible | impossible |
| redirector in the critical path | optional | **permanent** |

Two things the table makes easy to over-read:

**Opaque prevents brand impersonation in the hostname; it does not prevent
phishing.** A convincing login page at `k3f9q2mx.justapp.run` still works on
anyone who arrived from an email — the lure moves into the link text and the page
body. What readable labels add is specifically the deceptive hostname, which is
a real distinct harm (abuse reports quote hostnames, and brand holders complain
about them).

**Opaque adds a risk of its own.** An opaque hostname cannot be shared by hand,
so the pretty pointer becomes the link everyone actually passes around — which
puts a redirector permanently in the critical path. Readable labels let the app
origin *be* the shared link with no redirector at all. The comparison is
therefore less lopsided than it looks: opaque removes deceptive-hostname risk and
adds redirector risk; readable does the reverse.

The readable cost is mitigated rather than eliminated: **screen the label at
allocation** against a brand and confusables list. We allocate every label and
the label is immutable, so this is a chokepoint we fully control and pay once.
Screen the display name too.

Rules, either way:

- charset `[a-z0-9-]`, no leading or trailing `-`, and **`--` forbidden inside
  either part** — without that, `a-b` + `c` collides with `a` + `b-c`;
- DNS labels cap at 63 characters, so bound each part (≈24 each leaves headroom);
- reserve `www`, `api`, `_rt`, and anything operational;
- **no bare single labels** (`notes.justapp.run`) in v1 — that is a global
  namespace and a land grab. It can become a verified or paid feature later.

App-first because the app is the memorable part and the user is the
disambiguator. That ordering is a coin flip and is reversible before launch.

> **This is a one-way door.** Once apps are deployed and users hold local data
> keyed to origins, changing the scheme orphans all of it. Opaque is the
> conservative choice against the deceptive-hostname surface, and now is the only
> moment it is cheap.

### Getting on the PSL

Free, technically trivial, and slow — and the slowness is the only part that
affects sequencing.

The work: own the domain with **registration expiring more than 2 years out**
(under a year can trigger automatic deletion), open a PR against
[`publicsuffix/list`](https://github.com/publicsuffix/list) adding the entry to
the PRIVATE section, then add a DNS TXT record at `_psl.<domain>` containing that
PR's URL (RFC 8553 validation — deliberately chicken-and-egg: PR first, then the
record pointing at it). The rationale has to show broad user benefit, not just
our convenience; ours is the textbook case the PRIVATE section exists for —
mutually-untrusting parties issued subdomains under one domain. Submit the
preview domain in the same PR. No fees.

Maintenance is light but permanent: **keep the `_psl` record forever** (planned
automation flags missing records as removal candidates), keep the domain
registered, keep the contact reachable. Changes are another PR.

The cost is calendar time. The guidelines say plainly that there are *"NO SERVICE
LEVEL AGREEMENTS ON TIME nor any expectation of processing speed or urgency"* —
it is volunteer-maintained and visibly backlogged. And merge is not the finish
line: browsers **bundle a PSL snapshot per release**, so broad effect is months
past merge, on top of an unbounded review wait.

**It is not a launch blocker, and it is worth being precise about why:** the PSL
does not affect first-party storage isolation. `localStorage` and IndexedDB are
keyed by **origin**, always — so the per-app data separation this design rests on
works from day one, listed or not. What listing buys is cookie scoping,
same-site determination (`SameSite`, third-party storage partitioning keys), and
reduced blast radius when something is flagged. The first two are **entirely
about cookies**, and nothing here puts cookies on the content domain: the sync
credential is a scoped bearer token, app data lives in IndexedDB via the volume,
and the Clerk session is on the platform domain. Pre-PSL exposure is therefore
apps deliberately abusing cookie scoping against each other — real, bounded, and
untouched by the sync and token model.

Start it now because it is slow; treat it as hardening that lands when it lands.

### The link the user lands on

The pretty pointer is a **302, and the browser must end up showing the app
origin.** That address bar is load-bearing, not cosmetic: per-app permission
prompts and scoping, per-app PWA install, per-app storage the user can inspect
and clear, and — the important one — a flagged app burning *its own hostname*
rather than a shared path space.

The two alternatives both destroy the design:

- **Reverse-proxy / rewrite** (serve app content under `justapp.run/<user>/<app>`
  and keep the path URL in the bar) puts the app back on one shared origin,
  sharing storage and cookies with every other app. That is exactly the
  path-based hosting rejected above. Never proxy; always redirect.
- **Full-page iframe wrapper** (pretty URL in the bar, app in a frame) keeps the
  origin split but forfeits the app owning its URL, deep links, and PWA install —
  and makes phishing *worse*, since the bar shows our clean brand while hostile
  content renders inside it.

**The redirect must live on the content domain, never the platform one.**
Redirectors inherit the reputation of what they redirect to — it is why URL
shorteners get blocklisted, and Safe Browsing treats the chain as part of the
URL. A pretty pointer at `justapps.com/<user>/<app>` would make every shared app
link a platform-domain link, so a phishing app puts the auth domain into the
abuse report despite never serving a byte of that content. That is the precise
coupling [two domains](#two-domains-not-one) exists to prevent.

`justapps.com/<user>/<app>` therefore stays a **store page** — a listing that
describes the app and links to it. It is not a launcher, and it is not what
"Copy link" produces.

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
- **The bundle installs into the standalone volume too** — see
  [Both delivery paths, one runtime](#both-delivery-paths-one-runtime). The
  standalone `AppStore` reads from the app's own origin; everything downstream of
  `installApp()` is shared with the desktop.

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

- **Keep the platform domain out of the path entirely.** No redirect from
  `justapps.com` to app content — redirectors inherit the reputation of their
  targets. See [the link the user lands on](#the-link-the-user-lands-on).
- **A sacrificial preview domain.** Most abuse is drive-by from throwaway
  accounts, so gate the permanent namespace on verification:

  ```text
  *.justapp-preview.run   unverified authors; noindex, rate-limited, URL advertised as temporary
  *.justapp.run           verified authors only; permanent origins
  ```

  Abuse concentrates on the domain we can afford to lose. The trick is that
  **verification happens before first publish**, so no app ever migrates between
  domains — migration would change the origin and orphan storage, the one thing
  that must not happen. It also gives us deploy previews for free.
- **PSL entry** — distinct registrable units reduce (not eliminate) the chance of
  a blanket parent-domain block. Every peer host is listed: `github.io`,
  `vercel.app`, `netlify.app`, `web.app`. They host plenty of abuse and are not
  blanket-blocked. Start the submission early — it lands on nobody's schedule
  ([details](#getting-on-the-psl)).
- **Per-app hostnames** — a flagged app burns its own hostname, not a shared path
  space. Labels are readable, so they are **screened at allocation** against a
  brand and confusables list; see [the hostname scheme](#the-hostname-scheme).
- **`noindex` by default.** Phishing needs distribution. Let authors opt into
  indexing after account verification.
- **Cheap publish-time detections with real yield**: `<input type="password">` in
  an app declaring no `net` capability is nearly always phishing; brand
  names/logos near a login form; allowlisted hosts registered within 30 days.
- **Search Console + Microsoft Webmaster Tools on the content domain**, so a flag
  arrives as a notification rather than as user reports.
- **`abuse@` + fast takedown.** Response time is what Safe Browsing measures.
  Bundles are immutable behind a routing worker, so unpublish is one flip,
  global. Serve a distinct **410** on killed hostnames rather than anything
  app-shaped, so a re-crawl sees remediation.

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

## Both delivery paths, one runtime

Volume-installed apps and remote apps should be indistinguishable to a user. They
can be, because **a URL is a source, not a runtime mode.**

`appstore.ts` was written for this — *"the store is host-supplied (HTTP assets,
packaged FS bundles, future remote stores)"*. So a hosted app in the desktop is
`hostedAppStore()`: `AppStore.read()` pointed at our R2 instead of jsDelivr.
After install it is bit-for-bit an installed app — same volume, same offline,
same reducer sandbox, same `reconcile` updates, same escalation guard, same agent
tools. No second delivery path, and nothing for a user to notice.

### Therefore: install in both hosts

This settles the install-vs-serve question, in favour of installing:

- **Desktop** — install from `hostedAppStore()` into the user's volume.
- **Standalone** — install from a one-app `AppStore` over its own origin into its
  own IDB volume.

The standalone kernel needs `/applications/<id>/` anyway (`loadSandbox` →
`store.get(appId)` reads the volume) and it has a volume, so serving the bundle
outside the volume buys nothing. Installing gives one code path, the same
`installApp()` hash verification, the same `reconcile` for updates, and identical
offline behaviour. The SW drops from load-bearing to a convenience for the shell.
The difference between hosts collapses to *which `AppStore` was read*.

### What actually differs: the host capability surface

Not delivery — **what the app may assume about its host.** And the framework
already models exactly this: `docs/app.md` carries a per-capability availability
table across Frieren / Mac / App Code, `CAPABILITY_UNAVAILABLE` is a documented
failure mode, and apps are already expected to degrade when a host lacks
something (image generation exists on Frieren, not on Mac).

Hosted is a fourth column: `email`/`calendar`/`settings`/`devkit` unavailable,
`ai` grant-dependent, `volume` scoped to its own subtree. An app that declares
`email` and is opened standalone degrades the way it already degrades on Mac. No
new mechanism.

### The web-platform surface, and a correction

An earlier draft of this document claimed an iframed app cannot route. That is
too strong, and the distinction matters: `history.pushState` works fine inside an
ordinary cross-origin iframe, which has its own session history. It fails
**specifically on an opaque-origin `srcdoc` document**, where every target URL
fails the same-origin check. The problem is `srcdoc`, not iframes. What no iframe
can do is set the *top* document's URL, so deep-linking into a sub-view from
outside is the genuine casualty.

So, for an app to behave identically in both hosts, pick a surface:

1. **Portable-only.** Hosted apps get the desktop's surface — no raw History, no
   direct `fetch`, `net` capability only. One bundle, runs everywhere, genuinely
   no difference. Fine for most small apps (a crossword does not want routing),
   but gives up deep links standalone.
2. **Host-adaptive.** The app uses a routing *capability* rather than raw
   History; standalone maps it to real URLs, the desktop maps it to in-frame
   history. Identical app code, graceful degradation, and standalone is still a
   real website. Price: moving the desktop off `srcdoc` onto `iframe src` at a
   real origin — which is the `DevkitPreview {kind:'url'}` convergence
   `IFRAME_ISOLATION_PLAN.md` already nominates as the desktop's isolation
   upgrade, and which needs the app origin this project builds anyway. **The two
   projects fund each other.**
3. **Two declared classes** — a manifest flag and a store badge. The escape hatch
   for apps that cannot be portable, not the default.

> **PARKED — decide later.** (2) looks like the target and (1) is a respectable
> v1 that ships without touching the desktop's frame model, but nothing before
> the standalone host exists depends on this. It is deliberately not settled;
> revisit once one app is actually running on its own origin and we can see what
> authors reach for. Steps 1–5 of the build order are unaffected either way.

### The one difference worth keeping

Standalone has no agent; installed does. That is user-visible, and it should be —
it is the upgrade path, not a seam.

## Decision log

**Settled:**

1. Two registrable domains — platform and app content separate. **The pretty
   redirect lives on the content domain**, and the browser ends up showing the
   app origin; the platform domain hosts a store page that never launches an app.
2. Per-**app** origins, not per-user. Cookies are domain-scoped, so per-user
   subdomains bleed across the whole registrable domain.
3. **One** label, not two. A wildcard cert matches exactly one label, so
   `app.user.justapp.run` needs paid multi-level certs or per-user issuance
   (~50 new authors/week under Let's Encrypt).
4. The label is **immutable** — origin is storage identity, and changing it
   orphans anonymous users' IndexedDB. Renames move the platform pointer only.
5. The label is **readable and `--` separated**, screened at allocation. The
   deceptive-hostname surface is the cost; screening a namespace we allocate is
   the mitigation, and readable keeps a redirector out of the critical path.
   **One-way door** — opaque is the conservative alternative and this is the only
   cheap moment to take it.
6. **Unverified authors publish to a sacrificial preview domain**; verification
   precedes a permanent origin, so no app ever changes hostname.
7. Submit the app-content and preview domains to the **Public Suffix List** —
   early, since it is slow, but **not a launch blocker**: first-party storage is
   origin-keyed regardless, and nothing puts cookies on the content domain.
8. The security boundary is the **token's scope**, enforced server-side; the
   in-page kernel is a programming model, not a security mechanism.
9. **No build service.** Author's machine or browser compiles.
10. **Install in both hosts** — a URL is a source, not a runtime mode.
11. The reducer stays in a **Worker** even standalone, for discipline.

**Open:**

1. **The app surface** — portable-only vs host-adaptive routing. **PARKED**; see
   [the web-platform surface](#the-web-platform-surface-and-a-correction).
   Nothing before the standalone host depends on it.
2. **The first-sync merge rule** when both the anonymous volume and the account
   subtree hold data. Needed before step 5.
3. Where `net`'s host implementation runs — settled in principle (server-side),
   unsettled in detail (proxy shape, quota, allowlist grammar).
4. Hostname ordering: `app--user` vs `user--app`. Reversible before launch.

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
5. **The first-sync merge decision UI**, then `net`.
6. **The surface decision** — parked (see the decision log). If it lands on
   host-adaptive, moving the desktop off `srcdoc` onto `iframe src` at a real
   origin is also the desktop's isolation upgrade, so schedule it as one piece of
   work rather than two.

Step 4 is the one that can be wrong in a way that matters.

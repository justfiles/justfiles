# Remote-hosted apps (justapps)

> Status: **exploration.** No code. This is the option space for hosting app
> assets remotely — an app that is *also* a plain web page at a URL — as an
> **addition** to the local-first app system, not a replacement.
>
> Motivation: let an author publish an app with no infra ("GitHub Pages for
> apps"), and let that app be distributed as a link to people who have never
> heard of Kodama.
>
> `justapps.com` below is a placeholder. So is `justapp.run` — see
> [Two domains, not one](#two-domains-not-one) for why there are two.

## What the tree already decided

Four existing decisions constrain this, and three of them point the same way.

**The kernel is already host-agnostic.** `kernel({ fs, sandbox, capabilities })`
(`packages/app/kernel.ts`) knows nothing about where it runs. Two very different
hosts already build one over the same `app.js` bytes:

| | browser kernel | server kernel |
| --- | --- | --- |
| where | the tab | the user's Durable Object |
| sandbox | classic Worker inside a hidden opaque-origin iframe (`src/apps/sandbox.worker.ts`) | Cloudflare Worker Loader isolate, `globalOutbound: null` (`worker/kernel.sandbox.ts`) |
| volume | IDB replica | DO SQLite + R2 blobs |
| capabilities | `volume`/`settings`/`notify`/`devkit` local, rest proxied over one `_caps` socket | all local |

A third host would be a third `GetSandbox` + `Capabilities` pair. Nothing in the
kernel needs to change for any option below.

**An app is already a directory of files, addressed by a manifest id.**
`/applications/<id>/`, `/state/<id>.json`, `/data/<id>/`. Installing is writing
files; the whole install/verify/update machine (`packages/app/appstore.ts`:
per-file `sha256-` pinning, whole-app hash markers, monotonic `reconcile`,
`escalatesCapabilities`) is already written and host-agnostic.

**The GUI is already isolated harder than a web page.** Every GUI — built-ins
included — runs in an opaque-origin `sandbox="allow-scripts"` iframe whose CSP is
`default-src 'none'; connect-src 'none'` (`src/apps/gui-channel.ts`). Its only
authority is a `MessagePort`. This matters enormously below: **serving apps from
a real origin is a downgrade in isolation unless the shell keeps the iframe.**

**`IFRAME_ISOLATION_PLAN.md` already wrote down the answer to half of this.** Its
appendix ("URL-served apps, the app origin, and Service Workers") concludes:

> Adopt **URL-served apps from a dedicated app origin, backed by that origin's own
> (backend-free) Service Worker for offline** as the shape of the future
> cross-origin isolation upgrade. […] Use a subdomain for origin isolation, or a
> separate registrable domain if process/Spectre isolation is in scope.

So the hosting idea is not a detour from the isolation roadmap — it *is* the
isolation roadmap, arriving early for a product reason instead of a security one.

The one decision that cuts the other way: `APP_STORE_PLAN.md` deliberately chose
**"the store is a search index over npm — we never host, build, review, or
distribute third-party code."** Hosting bytes reverses that. See
[Liability](#the-decision-hosting-actually-reverses).

## The reframe

The question "where do we run the reducer / store the data / do auth" is hard
because it treats "a hosted app" as one thing. It is three, and they separate
cleanly:

1. **Bytes + identity** — an immutable, content-addressed bundle (`manifest.json`,
   `app.js`, `gui.js`, icon), a namespace that says who published it, and a URL.
2. **A runtime** — a kernel: dispatch queue, state store, capability resolution.
3. **A volume + a capability set** — whose data, and which host services.

Only **(1) is new infrastructure.** (2) exists twice already. (3) exists and is
owned by Kodama.

Every question the brief raises turns out to be a question about which existing
(2) and (3) a given *context* binds to:

| context | runtime | volume | capabilities |
| --- | --- | --- | --- |
| app opened inside Kodama | browser kernel (+ DO for the agent) | user's synced volume, chrooted to `/data/<id>` | full, install-consented |
| app opened standalone, anonymous | browser kernel | **local IDB volume on the app origin**, same `/data/<id>` shape | `volume` + `notify` only |
| app opened standalone, signed in | browser kernel | user's synced Kodama volume — *the same one* | consented subset |

The third row is the whole trick: a standalone signed-in app writes to
`/data/<app-id>` **in the user's one real volume**, because that is exactly the
chroot the `volume` capability already hands it (`resolveVolume`,
`packages/app/capabilities/volume/host.ts`). There is nothing to "consolidate"
between justapps and Kodama, because there is only ever one durable volume. The
anonymous row is a scratch replica that gets *imported* once, never merged
continuously.

## Two domains, not one

The brief says `justapps.com/user1/app1` — apps as **paths on one origin**. This
is the one premise worth pushing back on hard, for two independent reasons.

**Path-based hosting gives every app the same origin.** `localStorage`, cookies,
IndexedDB, and `fetch` credentials are per-origin. App B on the same origin can
read app A's storage and impersonate it against any API. That is strictly worse
than the opaque-origin iframe apps get today. GitHub Pages, Glitch, StackBlitz,
and CodeSandbox all moved to per-project subdomains for exactly this.

**Arbitrary user HTML must not share a registrable domain with your auth origin.**
Someone will publish a phishing page. If it lives at `justapps.com/*` and your
Clerk sign-in lives at `justapps.com`, one Safe Browsing flag takes down your
platform, and cookie/`document.domain`/CORS-adjacency mistakes become one config
error away. This is why GitHub serves user content from `githubusercontent.com`,
Vercel from `vercel.app`, CodeSandbox from `csb.app`.

So:

```text
justapps.com              the platform: publish, browse, docs, author accounts
<app>.<user>.justapp.run  one origin per app version channel — the app itself
```

Two registrable domains, wildcard DNS + wildcard TLS on the second. Subdomains of
one domain are *same-site*, so a browser may still coalesce them into one process —
a separate registrable domain is what buys process isolation, which is precisely
the Spectre escalation the isolation plan left open.

The pretty link (`justapps.com/user1/app1`) still exists — as a redirect to the
real app origin, and as the app's page in the store.

## The options

### A — Registry only

justapps hosts **bytes and identity**, nothing else. Publishing writes an
immutable bundle to R2 and appends a catalog entry. `shared/appstore.ts` grows a
`hostedAppStore()` alongside `communityAppStore()`; a link resolves to
`mykodama.app/?install=<id>`, which installs and opens it in the desktop.

- Replaces (or races) `APP_STORE_PLAN.md` Step 3 — the npm crawl, the
  jsDelivr hop, the id↔package binding heuristics, the indexer lag. A registry
  you own authenticates the publisher at publish time and *assigns* the id
  binding instead of inferring it. Strictly better mechanics.
- No new origin, no CORS, no second auth surface, no runtime work. Days, not
  weeks.
- **Does not deliver the actual motivation.** "Distribute your app without your
  users touching Kodama" is unmet. Everything still lands in the desktop.

### B — Registry + standalone shell *(recommended)*

A, plus a **static shell page** served at each app's own origin. The shell is
byte-identical for every app; it reads the app id from its own hostname, fetches
the immutable bundle, and stands up a browser kernel — reusing
`src/apps/host.ts`, `gui-channel.ts`, and `sandbox.worker.ts` **verbatim**. One
window, no desktop chrome, no dock, no agent.

The runtime split by sign-in state is exactly the table in
[The reframe](#the-reframe):

- **Anonymous** — an IDB volume on the app origin. Zero server cost, works
  offline immediately, no account needed to try an app. This is what makes a
  shared link actually work.
- **Signed in** — Clerk on the app origin (satellite domain of the existing
  instance), `synced({ local: idb, remote: remoteSyncReplica(...) })` pointed at
  `mykodama.app/fs`, and the `_caps` socket for `ai`/`email`/`calendar`. Same
  volume, same DO, same everything.

The shell must keep the guest in its sandboxed iframe even though it is already
on a distinct origin — because *the shell* holds the Clerk token and the volume,
and the guest must not. Shell = the trusted half (kernel, token, sync); guest =
the same opaque-origin iframe as today. Nothing about the guest's contract
changes, which is what "integrates with frieren perfectly" concretely means:
**one runtime, two shells.**

Cost: a real second origin (DNS/TLS/wildcard), CORS + satellite auth on the
Kodama worker, a capability-consent surface that isn't the install sheet, and
the liability posture flip. No new server runtime, no new database, no per-app
compute.

### C — Full hosted runtime (the brief as written)

Reducer in a Cloudflare Worker per app, volume provided by justapps.

Concretely worse for the app model this repo has:

- The reducer is a **pure synchronous function over JSON state**. Putting a
  network round-trip in front of every `t.on` turns a keystroke into a fetch and
  discards offline and local-first — the property `LOCAL_FIRST_PLAN.md` was
  written to obtain.
- It creates a second durable store, which creates the consolidation problem in
  question 2. That problem is *self-inflicted by this option* and does not exist
  in A or B.
- It is a second metering/quota/abuse surface (`worker/quota.ts` exists once, per
  user, in the DO).
- The DO **already** runs the reducer server-side, headless, for the agent. The
  only thing genuinely missing is a *shared, per-app-instance* kernel — which is
  not "hosting", it is multiplayer.

**Defer, don't discard.** Server-authoritative reducers are the right answer for
a real class of apps (shared documents, a public guestbook, a leaderboard,
webhook receivers, scheduled runs with no tab open). Treat it as a later **app
backend tier** layered on the same bundle format — an app declares it wants a
shared instance, and gets a DO keyed by `(app id, room id)` instead of by user.
Same kernel, different `fs` and different key. Nothing in A or B forecloses it;
B is a prerequisite for it (you need the URL and the identity first).

### D — Publish from the browser *(not an alternative — the wedge)*

Not a hosting architecture; a feature that only B unlocks, and probably the most
valuable thing here.

`packages/app-code` is already an in-browser authoring environment with a devkit
that compiles, typechecks, and `pack()`s a draft to a zip. Add one button:
**Publish**. Write an app in the Code app, hit Publish, get a URL you can send to
someone. No repo, no npm account, no build step, no CLI, no local toolchain.

Nobody else has that. It is a few hundred lines on top of B — `devkit.publish`
that POSTs the packed bundle to the registry — and it is the demo.

## Recommendation

**A → B → D, with C explicitly deferred as the app-backend tier.**

A is worth doing on its own merits regardless: it is a better app store than the
npm indexer that is currently planned but unbuilt, and it is the foundation of
everything else. B is where the motivation is actually satisfied. D is where it
becomes a product people talk about.

## The four questions, answered

### 1. Where does the reducer run?

**In the browser, in the sandbox that already exists** — `browserSandbox()`,
Topology B. Not on the server, for any option except C.

The reducer runs where the volume it reduces over is local. Under B that is
always the tab, whether the volume is an anonymous IDB replica or the synced
Kodama replica. The server kernel keeps doing what it does today: headless work
for the agent, cron, and maintenance, in the user's DO.

The exception, and it is worth naming clearly: **the moment two users must see
the same state, the reducer has to move server-side**, because a shared state
machine needs a single writer. That is option C, it is a different product tier,
and it should be an app-declared opt-in rather than the default runtime.

### 2. Where does the data live, and how does it consolidate?

**There is exactly one durable volume per user, owned by Kodama.** justapps never
owns durable user data. Consolidation is not solved — it is *avoided*, by never
creating the second store.

- Anonymous standalone → IDB on the app origin. Local, free, offline, per-app
  isolated (because per-app origin). It is a **scratch** volume.
- Signed-in standalone → the user's Kodama volume over the existing sync client,
  chrooted to `/data/<app-id>` by `resolveVolume` — the identical subtree the app
  gets inside the desktop.
- Anonymous → signed in → a **one-time import** of that app's `/data/<id>`
  subtree, not a continuous merge. The same shape as the local-profile →
  account offer that already ships (`shouldOfferMigration`,
  `shell/MigrationSheet.tsx`). `LOCAL_FIRST_PLAN.md` open decision 7 already
  ruled: *do not auto-merge*. Keep that ruling.

Two things to decide, not obvious either way:

- **A standalone app that declares a path scope** (`volume({ scopes: ['/notes'] })`)
  wants the *shared* user volume, not its private chroot. Standalone-anonymous
  cannot honor that. Cleanest: such an app refuses to run anonymously and
  requires sign-in + explicit consent — the scope is visible in the manifest, so
  the shell can decide before booting anything.
- **Does opening a signed-in standalone app install it into Kodama?** I think it
  should: it removes an entire class of "the app I used on the web isn't in my
  desktop" confusion, it is the growth loop, and it makes the agent able to drive
  the app afterward. The bytes reach the DO for free — they are files in the
  volume, and the volume syncs.

### 3. Auth

Three separate things that are easy to conflate:

**Runtime identity (who is the user).** One Clerk instance, `justapp.run` as a
satellite domain. The token the shell obtains is the same token the desktop uses,
so `/fs` and `/api/apps/_caps/ws` need CORS and an origin allowlist and nothing
else. The guest iframe never sees it — it holds a `MessagePort`, same as today.

**Capability grant (what may this app touch).** Inside Kodama the *install* is
the consent event. Standalone there is no install, so opening a signed-in app
must be its own grant: "app1 by user1 wants your files (its own folder) and AI."
The manifest already carries `capabilities` as static metadata, and
`escalatesCapabilities()` already computes the diff for re-consent. Store grants
in the volume (`/private/**` never replicates off-device; a synced path makes
them revocable from Settings on any device — pick deliberately) keyed by
`(origin, app id)`.

**Publisher identity (who may write `user1/*`).** Registry-side, at publish time.
Same Clerk user, plus a CLI/API token. This is the part a hosted registry does
*better* than the npm index — `APP_STORE_PLAN.md` needs a reserved-prefix guard
and a two-way id↔package binding with first-claim-wins precisely because it
cannot authenticate the publisher. A registry can just check.

### 4. What isn't on the list

**No network capability exists.** Apps run under `connect-src 'none'`. The
capability set is `volume`/`ai`/`image`/`email`/`calendar`/`notify`/`settings`/`devkit`
— there is no `fetch`. The instant the pitch is "publish your app as a web app,"
authors will want to call their own API, and today the honest answer is "you
can't." This is the largest missing piece and it is a real fork: either add a
declared `net` capability with an author-declared host allowlist surfaced on the
consent sheet (and accept that it reopens the exfiltration hole the frame CSP
closed), or state loudly that apps are local-first-only and that is the point.
Decide this **before** publishing a hosting product, not after.

**Liability, hosting, and abuse.** `APP_STORE_PLAN.md`'s entire posture — "we are
a search engine, not a distributor" — was chosen to avoid this, and hosting
reverses it. You acquire: DMCA process, malware and phishing takedowns, CSAM
reporting obligations, egress cost, and domain reputation risk. Mitigated by the
second registrable domain, an existing denylist design, and immutability, but not
eliminated. Worth an explicit "yes, we're becoming a distributor" rather than
sliding into it.

**Immutability is load-bearing for the existing installer.** `installApp()`
verifies every file against a pinned `sha256-`. Bundles must be
content-addressed and versions immutable (`<app>-v1-2-3.<user>.justapp.run`, or a
version path under the app origin, plus a mutable `latest` pointer). Bonus: the
whole hosting product becomes R2 + a routing worker + one static shell, all
immutable and edge-cacheable forever — near-zero marginal cost per app, which is
what makes "no infra for the author" also true for the operator.

**Offline and PWA fall out for free, and they're a real feature.** A per-app
origin can register its own Service Worker and serve the shell + bundle from its
own cache with no backend (the appendix in `IFRAME_ISOLATION_PLAN.md` works this
through). Each app therefore becomes independently installable as a PWA — its own
icon, its own name, its own window, from a link. That is a strong author pitch
and it costs almost nothing on top of B.

**The agent is the asymmetry that makes the funnel work.** A standalone app has
no agent — no tool discovery, no `os windows`, no chat. Inside Kodama it does.
That is the right gradient: the free link is genuinely useful, and "Open in
Kodama" is a real upgrade rather than a nag. Don't accidentally erase it by
adding an agent to the standalone shell.

**Two URLs must not fork one app's state.** The manifest id stays the canonical
storage identity (`/state/<id>.json`, `/data/<id>/`); the URL is a distribution
pointer. `APP_STORE_PLAN.md` already reasoned this through for npm names — the
same rule holds, and a registry can enforce it at publish time instead of
inferring it from a crawl.

**`DevkitPreview {kind:'url'}` finally applies to frieren.** Quay serves apps by
URL and has a `{kind:'url'}` preview; frieren has `{kind:'window'}` because it had
no server. Once the app origin exists, the two hosts converge on one delivery
model — which the isolation plan flagged as a benefit of this move.

## Non-goals (for the first pass)

- Server-side reducers, shared/multiplayer state, webhooks, cron-per-app
  (option C — the app backend tier, later).
- Hosting anything but built app bundles. No build service. Running untrusted
  builds is the worst liability in this space; `APP_STORE_PLAN.md` already ruled
  it out and that ruling survives.
- Ratings, comments, featured lists, paid apps.
- Replacing the local app system. Local install, zip install, and app-code drafts
  all keep working unchanged.

## Smallest useful slice

If this is worth testing before committing to the domain and the shell:

1. **Publish one bundle to R2 by hand**, behind a `hostedAppStore()` in
   `shared/appstore.ts` (a near-copy of `communityAppStore`, minus the jsDelivr
   hop). Install it into the desktop from a link. Proves the registry half of A
   with no new origin and no new auth.
2. **Stand up one app origin with the static shell**, anonymous-only, IDB volume,
   reusing `host.ts` unchanged. Proves the shell is genuinely the same runtime —
   if `host.ts` needs to fork, the whole "one runtime, two shells" claim is
   wrong and everything above needs revisiting.
3. Only then: satellite Clerk, CORS on `/fs`, the grant sheet, and sign-in.

Step 2 is the real risk gate. Everything else is plumbing.

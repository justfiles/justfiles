# Frieren iframe isolation plan

> Status: **Steps 1–4 shipped; Step 5 open.** Moved untrusted app code (GUI, then
> reducer) behind an opaque-origin sandboxed `<iframe>` so a third-party app can no
> longer reach the host origin, DOM, token, cookies, or synced volume. This is the
> browser analog of the server's `globalOutbound: null`, and what makes third-party
> app installs safe.
>
> The GUI frame is `FRAME_SRCDOC` in `src/apps/gui-channel.ts`; the reducer frame is
> `REDUCER_FRAME_SRCDOC` in `src/apps/sandbox.worker.ts`. What remains is Step 5
> (trust gating + lifecycle), which was always optional and decision-driven.
>
> Nothing here changes the **app authoring API**, the **kernel**, the **sandbox
> protocol**, the **capability trust model**, or the **agent/server path**. It is a
> transport relocation, not a redesign — because the platform already brokers every
> app interaction through the kernel over message passing.

---

## Background: where the boundaries were before this plan

The starting point Steps 1–4 moved away from. An app was two halves with very
different isolation:

- **Reducer (`app.ts`)** — ran in a **Web Worker** (`src/apps/sandbox.worker.ts`),
  one per content-hashed bundle. Talked to the kernel only through the postMessage
  RPC protocol in `packages/app/sandbox.ts`. Off the main thread, but **same-origin**
  (a Worker can `fetch()` with the user's cookies) → *not* a security boundary.
- **GUI** — `import()`-ed from a blob URL and mounted into a plain `<div>`
  (`src/apps/host.ts` → `AppViewport.tsx`), in **the host document and the host JS
  realm**, sharing the host's framework instance (at the time, React externalized via
  a `/vendor/*.js` importmap — since removed; an app now bundles whatever framework it
  uses). This was the real hole: the GUI could read the Clerk token,
  `document.cookie`, `localStorage`, the whole synced volume in IndexedDB, tamper with
  the shell, and exfiltrate anywhere.

Of the five app↔system links, **only one is an in-realm function call**:

| Link | Today | Boundary? |
| --- | --- | --- |
| **GUI ↔ kernel** (`transport.invoke`/`subscribe` in `host.ts`) | direct function call | ❌ in-realm |
| Kernel ↔ reducer | postMessage (`sandbox.ts` / `sandbox.worker.ts`) | ✅ |
| Reducer → capabilities (`t.cmd` result, `app.invoke`) | mediated by kernel `caps.invoke` | ✅ |
| Capabilities → server (ai/email) | Cap'n Web RPC over `_caps` WebSocket | ✅ |
| Agent → reducer | server kernel + synced `/state/<id>.json` + `volume.watch` | ✅ |

The kernel is already the single trusted mediator, and `packages/app/sandbox.ts` is
already transport-agnostic (`{ post, onMessage }`). So the whole project is: turn the
one in-realm link into a message channel, then relocate the untrusted halves behind an
iframe wall — the contracts crossing each link do not change.

## Trust model target

- **Host (trusted), stays on the main thread:** the kernel, the capability registry
  (`caps`), the volume/IndexedDB, the token and the `_caps` WebSocket.
- **Iframe (untrusted, opaque origin):** the GUI, and — for credential isolation — a nested
  Worker running the reducer.

The untrusted side's only host API is **one MessagePort to the kernel**. The kernel
dereferences local capability names into trusted `{ id, scopes }` (see the scope
resolver in `packages/app/kernel.ts` — "a compromised isolate cannot escalate scope").
Iframing does not remove any *intended* authority; it removes the *ambient* authority
the GUI accidentally has by running in the host realm. It does not give total network
egress isolation. CSP `connect-src` does not control WebRTC, so treat data sent to
publisher GUI code as disclosed to the publisher.

## Two topologies

- **Topology A** — iframe the **GUI only**; the reducer Worker stays on the host.
  Closes the GUI hole. The reducer can still `fetch` with credentials.
- **Topology B** — iframe the **GUI and a nested reducer Worker**. The Worker inherits
  the iframe's opaque origin → neither half can `fetch` with credentials. The kernel
  stays on the host and reaches the reducer over one extra hop.

The plan builds A first (Step 3), then B (Step 4).

## What stays untouched (the payoff)

- `packages/app/kernel.ts` — dispatch/queue/command/subscription machinery.
- `packages/app/sandbox.ts` — the dispatch/invoke/settled/runProcedure protocol.
- The capability trust model + scope resolution.
- The server capability proxy + `_caps` WebSocket + token handling.
- The agent path (server kernel + synced state file + `volume.watch`).
- The app authoring API (`defineApp`, `defineGUI`, capabilities). App authors change
  nothing.

---

## Step 1 — Remove the menu system (M) ✅ SHIPPED

### Context

The universal menubar lets a GUI export `menu`, which the host renders for the focused
app; items carry `onSelect: () => void` closures. A function cannot cross a postMessage
boundary, so the menubar is the one contract incompatible with an iframe. It is not
essential and is wired by only three apps — remove it to simplify everything downstream.

It is **not** truly unused (that's why this is one cohesive step): `app-paint` and
`app-notes` export `menu`, and `app-code` renders the *previewed* app's declared menu
via `menu` (framework) → `setMenu` → `stage.menu` → `menuOf(previewId)`
(`devkit.client.ts`) → its own `menu` procedure → the `Menubar` UI. The whole chain goes
dead the moment the framework feature is removed, so it must all land together to keep
the tree green.

### Expectation

No `Menu`/`GUIMenu`/`setMenu` anywhere; no shell menubar; `app-paint`/`app-notes` lose
their host menu (functionally covered elsewhere); `app-code` no longer shows a preview
menubar. Build + tests green.

### How to do it

- **Framework**
  - `packages/app/browser.ts`: delete `MenuItem`, `Menu`, the `menu` option on
    `defineGUI`, `setMenu` from the mount `ctx`, and the `publishMenu` logic. The mount
    ctx shrinks to `{ transport }`.
  - `packages/app/react.ts`: delete `GUIMenu`, `GUIModule.menu`, the `menu` branch in
    `reactGui`, and the `Menu` import.
- **Frieren host/shell**
  - `src/apps/host.ts`: delete `menuSubscribers`, `notifyMenus`, `subscribeMenus`,
    `menuOf`, `stage.menu`, `setMenu` in `mountGui`, and all `notifyMenus()` calls.
  - `src/shell/DesktopShell.tsx`: remove the menubar import + render.
  - `src/apps/devkit.client.ts`: remove `host.menuOf(previewId)` / `selectMenu` usage.
- **Apps**
  - `apps/paint/src/gui.tsx`: delete the `menu` block — the in-GUI `<Toolbar>`
    (`onTool`/`onSize`) already covers Tools/Brush (S).
  - `apps/notes/src/gui.tsx`: delete the `menu` export — the items only fire
    `window` events the palette/shortcuts already trigger (S).
  - App Code: remove the `menu` procedure (`src/app.ts`), the `Menubar` +
    dropdown UI (`src/editor-screen.tsx`, `src/editor-view.tsx`), and the `.menu({})` /
    `.selectMenu()` calls. This is the bulk of the step.

### Code shape

The GUI mount contract loses `setMenu`; that's the whole framework-visible change:

```ts
// packages/app/browser.ts — after
mount(el: HTMLElement, state: State | null, ctx: { transport: Transport }): GuiInstance
```

### Verify

```sh
pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test
```

Manually: paint's Tools/Brush still work via its toolbar; notes' New/Open still work via
palette/shortcuts; app-code preview renders without a menubar.

---

## Step 2 — GUI transport over a serializable channel, still in-realm (M) ✅ SHIPPED

### Context

Before adding the opaque-origin wall (blob workers, `srcdoc`, React delivery), first
route the GUI's `transport` through a `MessageChannel` **with both ports in the current
realm**. This proves the serialization contract and the "load GUI from bytes over a
port" path in isolation. When Step 3 adds the iframe, only *where* the port lives
changes — not *what* crosses it.

### Expectation

Apps behave identically, but every GUI↔kernel message is now serializable data (actions
in, state out). No functional change; a pure refactor that de-risks Step 3.

### How to do it

- Add a **host-side adapter** `guiHost(kernel, appId, port)` that:
  - listens on `port` for `{ type: 'invoke', id, action }` → `kernel.dispatch(appId,
    action)` → posts `{ type: 'invoked', id, result }` or `{ type: 'invokeError', id,
    error }`;
  - forwards state to the guest: subscribe to kernel `app.update` for `appId` **and** the
    existing `volume.watch` remote re-read (both already funnel through `pushState` in
    `host.ts`) → posts `{ type: 'state', state }`.
- Add a **guest-side adapter** `guiClient(port): Transport` implementing the existing
  `Transport` interface (`invoke`, `subscribe`) over `port` — mirror the request/reply
  correlation already written in `sandboxClient` (`packages/app/sandbox.ts`).
- Extract the GUI load+mount in `host.ts` `bootLocal` into a **guest bootstrap** that
  takes only `{ port, guiCode, state }`, builds `guiClient(port)`, `import()`s the GUI
  bytes, and calls `mod.gui.mount(el, state, { transport })`.
- In `host.ts`, wire `const { port1, port2 } = new MessageChannel()`; call
  `guiHost(kernel, id, port1)` and hand `port2` to the guest bootstrap **in-realm** for
  now (direct function call, no iframe yet).

### Code shape

Reuse the existing wire vocabulary; the guest client is the mirror of `sandboxClient`:

```ts
// guest side (mirrors packages/app/sandbox.ts sandboxClient)
function guiClient(port: MessagePort): Transport {
	let nextId = 0
	const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
	const subscribers = new Set<(state: unknown) => void>()
	port.onmessage = (e) => { /* route 'invoked' | 'invokeError' | 'state' */ }
	return {
		invoke: (action) => new Promise((resolve, reject) => {
			const id = String(nextId++)
			pending.set(id, { resolve, reject })
			port.postMessage({ type: 'invoke', id, action })
		}),
		subscribe: (onState) => { subscribers.add(onState); return () => subscribers.delete(onState) }
	}
}
```

The message set is intentionally tiny — three types host→guest (`invoked`,
`invokeError`, `state`), one guest→host (`invoke`).

### Verify

```sh
pnpm typecheck && pnpm test
cd platform/frieren && pnpm run dev   # then, another shell:
pnpm run verify:ui                # open several apps; dispatch actions; confirm state renders and agent-driven updates still land
```

---

## Step 3 — Move the GUI into a sandboxed iframe (Topology A) (L) ✅ SHIPPED

### Context

The core milestone. Put the GUI inside a `sandbox="allow-scripts"` iframe (opaque
origin, no credentials). The reducer Worker **stays on the host** — do not touch
`sandbox.worker.ts` here. This removes the GUI's ambient authority: its only power
over the host becomes the port from Step 2.

### Expectation

Each app's GUI renders inside an iframe. It cannot read the token/cookies/DOM/shell.
Everything else — dispatch, live state, agent updates, capabilities — works unchanged.
First-open shows a brief cold start (~100–400 ms); re-focus is instant (the iframe
persists in the stage, like the current durable wrapper).

### How to do it

- **Stage becomes an iframe.** In `host.ts` `createStage`, replace the mount `<div>`
  with an `<iframe sandbox="allow-scripts">` filling the stage (`h-full w-full`). Keep
  the module-level stage Map + `AppViewport` slot model (the iframe is even more durable
  across React reorders than a div).
- **Bootstrap via `srcdoc`.** The iframe document is a tiny inline module that: opens a
  port to the parent, receives the gui.js bytes + initial state, `import()`s gui.js off
  a blob URL, and runs the Step-2 guest bootstrap. It requests nothing over the network.
  *(As shipped this needed no importmap: an app bundle carries whatever framework it
  uses, so there is nothing left to resolve — see `FRAME_SRCDOC`.)*
- **Deliver bytes, not URLs.** The host already reads gui.js from the volume in
  `bootLocal` and posts the bytes into the iframe. This keeps the opaque-origin iframe
  offline-capable and CORS-free.
- **Hand off the port.** After the iframe signals ready, transfer `port2`:
  `iframe.contentWindow.postMessage({ type: 'boot', guiCode, state }, '*',
  [port2])`. `guiHost` keeps `port1`.
- **UX plumbing.** ResizeObserver is unnecessary (the iframe fills the stage);
  click-to-focus still works through the stage. The menubar is gone (Step 1), so there
  is no cross-frame menu to bridge.

### Code shape

Only the *delivery* and *port hand-off* are new; the guest bootstrap is Step 2's, now
running inside the iframe:

```ts
// host.ts — replaces the inline import()+mount in bootLocal
const iframe = stage.frame // <iframe sandbox="allow-scripts" srcdoc=…>
const { port1, port2 } = new MessageChannel()
guiHost(kernel, stage.id, port1)                        // trusted side stays here
await frameReady(iframe)                                 // srcdoc posts 'ready'
iframe.contentWindow!.postMessage(
	{ type: 'boot', guiCode, state: snapshot },          // bytes, not URLs
	'*',
	[port2]                                               // the app's only host API
)
```

```html
<!-- srcdoc bootstrap (shape) -->
<script type="module">
	const parent = window.parent
	window.addEventListener('message', async (e) => {
		if (e.data?.type !== 'boot') return
		const [port] = e.ports
		const mod = await import(blobUrl(e.data.guiCode))  // self-contained: nothing to resolve
		mod.gui.mount(document.getElementById('root'), e.data.state, { transport: guiClient(port) })
	})
	parent.postMessage({ type: 'ready' }, '*')
</script>
```

### Decision to lock here

Opaque-origin **same-process** (`sandbox` attribute; cheapest; kills credentials + DOM)
vs a dedicated **cross-origin `usercontent` domain** (adds process isolation; needs
infra + CORS). **Recommend starting same-process** and revisiting cross-origin only if
Spectre-class cross-frame reads enter the threat model.

### Verify

```sh
pnpm typecheck && pnpm test
cd platform/frieren && pnpm run dev && pnpm run verify:ui
```

Inside `verify:ui`, additionally assert isolation with a quick console probe in the app
frame: `document.cookie` is empty, `window.parent`'s document is unreachable
(cross-origin throw), and the app cannot obtain the token. Confirm dispatch + live state
+ an agent-driven `run` still reflect in the open window.

---

## Step 4 — Move the reducer worker into the iframe (Topology B) (M–L) ✅ SHIPPED

> **Risk gate: PASSED → Topology B (validated Chromium/Firefox/WebKit).**
> A module Worker does **not** spawn from a blob URL inside a
> `sandbox="allow-scripts"` (no `allow-same-origin`) iframe on **Chromium**
> (`worker.onerror`, opaque origin); it *does* on Firefox and WebKit. The
> portable path that works on **all three** is a **classic** Worker that
> `import()`s the app bundle dynamically (the blob URL is handed in via the
> Worker `name`, read as `self.name`). Under the Step-5a CSP
> (`default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:;
> connect-src 'none'`) that classic+dynamic-import worker still spawns, and a
> credentialed `fetch` to the host origin from inside it is blocked in every
> engine — direct fetch is deny-by-default. So we take Topology B (not the SES
> fallback), with the classic-worker adaptation baked into
> `sandboxWorkerSource(..., 'web-iframe')` and guarded by
> `platform/frieren/scripts/reducer-frame-probe.ts` (real-browser check) plus a
> shape unit test in `packages/app/sandbox.test.ts`.
>
> **Design note — one shared reducer frame, not per-stage.** The kernel loads a
> reducer for *closed* apps (install/seed/reconcile warm `subscriptions(state)`
> via `subs.ensure → loadSandbox`), and `packages/app/kernel.ts` stays untouched.
> So the reducer realm cannot be tied to a GUI stage's lifecycle. A single hidden
> opaque-origin iframe (created lazily with the kernel, torn down on OS teardown)
> hosts *every* app's reducer Worker, keyed by content hash — exactly the
> `iframeSandbox(frame)` / `frame.spawnReducer(appId, code)` shape below. GUI
> frames stay per-stage (Steps 1–3, unchanged). The `browserSandbox()` /
> `terminateAppWorker(appId)` surface is preserved so `kernel.client.ts` and
> `host.ts` don't churn.

### Context

Total isolation: spawn the reducer Worker **inside** the opaque-origin iframe so it
inherits that origin and cannot `fetch` with credentials. The kernel stays on the host
and reaches the reducer over one extra hop; the `sandbox.ts` protocol is unchanged.

### Expectation

Neither the GUI nor the reducer can reach the host origin. The kernel, capability
resolution, and agent path are byte-for-byte the same — they simply traverse the iframe
relay.

### How to do it

- **Validate first (risk gate).** Confirm a module Worker spawns inside a
  `sandbox="allow-scripts"` (no `allow-same-origin`) iframe on all target browsers. If
  blocked, **stay on Topology A** and harden the host-side reducer Worker separately
  (e.g. SES lockdown) — record the fork in this step and stop.
- **Tunnel the sandbox transport.** Today `browserSandbox()` (`sandbox.worker.ts`) builds
  a `Sandbox` over a parent-owned Worker via `sandboxClient({ post, onMessage })`.
  Change `GetSandbox` so the Worker is created *inside the iframe* and the `{ post,
  onMessage }` transport tunnels frames through the iframe port to that nested Worker.
  `sandbox.ts` and `sandboxWorkerSource` are **unchanged** — the frames just take one
  more hop.
- **Multiplex the port.** The iframe port now carries two logical channels — GUI
  (Step 2/3) and reducer (this step). Tag frames with a channel discriminator so the
  relay routes them; keep the correlation ids per channel.

### Code shape

The kernel is untouched — it still receives a `Sandbox`; only the transport's bytes take
a different route:

```ts
// sandbox.worker.ts — Topology B
export function iframeSandbox(frame: AppFrame): GetSandbox {
	return async ({ appId, code }) => {
		await frame.spawnReducer(appId, code)          // Worker created INSIDE the iframe
		const { sandbox } = sandboxClient({            // UNCHANGED client from packages/app/sandbox.ts
			post: (m) => frame.post({ channel: 'reducer', appId, msg: m }),
			onMessage: (h) => frame.onReducer(appId, h)
		})
		return sandbox
	}
}
```

Capabilities need no change: a procedure's `app.invoke(...)` host-call still rides the
sandbox transport back to the **host** kernel's `invokeCapability`, which resolves scopes
and runs the trusted, host-side capability. The iframe never touches the token, the
WebSocket, or the volume.

### Verify

```sh
pnpm typecheck && pnpm test
cd platform/frieren && pnpm run dev && pnpm run verify:ui
```

Probe from inside the reducer's realm (via a temporary debug action) that a
credentialed `fetch` to the host origin fails, while a `volume`/`ai` capability call —
brokered by the host kernel — still succeeds. Confirm procedures (`app.invoke`,
`app.dispatch`, `app.settled`) still resolve across the extra hop.

---

## Step 5 — Trust gating + lifecycle (optional, decision-driven) (M, splittable)

### Context

Keep the fast in-realm path for trusted built-ins and pay the iframe tax only for
third-party apps; and bound steady-state memory so "opened 30 apps this session" costs
like "3 apps in the foreground."

### Expectation

Built-ins mount in-realm (instant, shared React); untrusted apps mount in an iframe
(isolated). Backgrounded untrusted apps can be suspended and restored from persisted
state.

### How to do it

- **5a — trust gate + CSP.** Add a trust flag (manifest field or host allowlist).
  Branch in `host.ts` between the Step-2 in-realm mount (built-ins) and the Step-3/4
  iframe mount (third-party). Add a CSP to the iframe document (`default-src 'none'`
  plus only the blob sources it needs).
- **5b — suspend/restore.** State is already JSON-persisted at `/state/<id>.json` and
  rehydrated verbatim. Tear down a backgrounded untrusted iframe+worker and restore it
  from persisted state on re-focus (paying one cold start again), so resident memory
  tracks visible/recent apps, not ever-opened apps.

### Code shape

```ts
// host.ts — one branch, two mount strategies behind the same guiHost/guiClient bridge
const mount = isTrusted(manifest) ? mountInRealm : mountInIframe
```

### Verify

```sh
pnpm typecheck && pnpm test && cd platform/frieren && pnpm run dev && pnpm run verify:ui
```

Confirm a built-in opens with no cold start and shares one React instance; a third-party
app opens in an iframe; backgrounding then re-focusing an untrusted app restores its
exact state.

---

## Appendix — Performance & scaling expectations

- **Cold start (per app, first open):** ~50–150 ms desktop, ~200–500 ms mid mobile —
  iframe boot + React parse/instantiate + Worker spawn + initial mount. Hideable with a
  stage skeleton. Re-focus of an already-open app is instant.
- **Steady state:** no rendering penalty after mount; often *better* cross-app
  responsiveness (a heavy/buggy app can't jank the shell). The postMessage boundary adds
  sub-ms per capability call/state push, and the framework already dispatches per
  semantic event, not per keystroke.
- **10 apps open ≈ 10–20 browser tabs.** Opaque-origin same-process iframes ≈ 10–20 MB
  each → ~100–200 MB; will not crash a desktop. Cross-site (own process) is ~tens of MB
  each but capped/coalesced by the browser. Constrained mobile is the only concern, and
  Step 5b (suspend/restore) removes it.

---

## Appendix — URL-served apps, the app origin, and Service Workers

A recurring question: quay/spud-mac serve each app by **URL** (`quayd` HTTP-serves
`gui.js`; the WKWebView loads `http://127.0.0.1:PORT/app/<id>`),
and a URL is a natural fit for an iframe `src`. `DevkitPreview {kind:'url'}` exists
*because* quay has a server to serve that URL. Could frieren-web do the same, using a
Service Worker as the "server" (it already ships one via VitePWA, and has all app
bytes offline in the Volume/IDB)?

**It's technically possible, but on a single origin it doesn't beat today's opaque
`srcdoc`, because isolation and SW-serving pull in opposite directions:**

| Approach | Isolated (no token/DOM reach)? | SW can serve it offline? |
|---|---|---|
| `iframe src="/apps/x/"`, same-origin | ❌ same-origin reaches parent + token | ✅ |
| `iframe sandbox src="/apps/x/"` (opaque) | ✅ | ⚠️ SW serves the *navigation*, but the opaque document is **not a SW-controlled client**, so its subresources (`gui.js`, assets) **bypass the SW** offline |
| dedicated **cross-origin** app domain, its own SW | ✅ (and process-isolatable) | ✅ |

A same-origin document can always reach its same-origin parent (a `CSP: sandbox`
header only reproduces the opaque case), so there is no header/blob/`data:` trick that
gives same-origin SW-serving **and** isolation. To keep isolation on one origin you
must inline `gui.js`+styles into the boot document — which is exactly what
`srcdoc` already is. Serving that same inlined payload via `iframe src` + a SW
navigation response instead of `srcdoc` + `postMessage` is a plumbing swap, not a
different isolation model.

### Do we need a real second domain in production, or a made-up one served by the SW?

**You cannot make a SW serve a fabricated origin.** A Service Worker is bound to one
*real* origin (the one it registered on) and only controls clients on that origin. The
browser resolves a host to a real registrable domain; a request to any other origin
never reaches the host origin's SW — it hits the network, or a SW registered on *that*
origin. There is no "virtual origin the SW conjures."

Consequences:

- **The only domain-less distinct origins are opaque** (`sandbox` / `blob:` / `data:`).
  Those are exactly *not* SW-controllable, and are unique per instance (no shared SW or
  persistent storage). That's what `srcdoc` uses today — no domain, and no SW needed for
  the iframe (bytes are inlined).
- **A SW-controllable isolated origin requires a real second origin to *exist*** (a
  subdomain or a separate domain: DNS + TLS). But it needs **no dynamic backend** — after
  a one-time load that registers its SW, that origin serves everything from its own SW
  cache offline. In production that's a backend-free static shell + `sw.js` (on Cloudflare,
  a subdomain/route returning that shell). So "the SW is the server" is true — it just has
  to be the SW *of that origin*, reached via a domain that genuinely resolves.
- **Origin vs site.** A subdomain (`apps.frieren.app`) gives origin isolation
  (token/cookies/DOM) and is SW-servable, but it is *same-site* (same registrable domain),
  so browsers may keep it in the host's process — weaker against Spectre-class cross-frame
  reads. Process-level isolation wants a *separate registrable domain* (a different site),
  which the browser can put in its own process.

### Decision

Keep the **same-process opaque `srcdoc` + `postMessage`** model for now: it delivers
isolation + offline with zero extra origins, domains, or SW routing, and the byte-inlining
it requires is unavoidable for any single-origin isolated approach.

Adopt **URL-served apps from a dedicated app origin, backed by that origin's own
(backend-free) Service Worker for offline** as the shape of the future cross-origin
isolation upgrade (decision 2 below). That is the point
where a URL model pays for its infra, and where frieren **converges with quay/spud-mac**
(`DevkitPreview {kind:'url'}` would then apply to frieren too). Use a subdomain for
origin isolation, or a separate registrable domain if process/Spectre isolation is in
scope.

**Trigger to revisit:** cross-frame memory reads enter the threat model, OR we want to
unify frieren's app-delivery with quay's URL model. Independent of delivery, a URL never
carries the live kernel bridge — the capability **port is always handed over
`postMessage`**, and the devkit preview always needs its scoped-kernel port.

## Open decisions

1. **All-apps-iframe vs trust-gated (Step 5a).** Now leaning **all-apps-iframe** (one code
   path, first-party devs hit the sandbox limits their users will); the devkit preview,
   the one host-DOM dependency, moves to its own window instead. Trust-gating remains the
   fallback if a built-in genuinely needs the host realm.
2. **Same-process opaque origin vs dedicated cross-origin domain (Step 3).** Start
   same-process; escalate only if cross-frame memory reads enter the threat model. When we
   escalate, serve apps by URL from that origin with its own SW for offline — see the
   "URL-served apps" appendix above.
3. **Reducer-in-iframe vs host Worker + SES (Step 4 risk gate).** **Resolved:**
   Topology B, via a **classic** Worker that dynamic-`import()`s the app bundle
   (module Workers are blocked in Chromium's opaque-origin iframes; the classic
   path works on Chromium/Firefox/WebKit, with and without the CSP). See the
   risk-gate banner on Step 4 and `platform/frieren/scripts/reducer-frame-probe.ts`
   (the real-browser check for the classic reducer Worker).

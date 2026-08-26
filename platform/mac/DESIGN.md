_platform/quay · design_

# quay — a native macOS shell where mini-apps dock at one shared backend

`quay` runs the same `@justfiles/app-*` apps frieren runs, but as **real macOS apps**: each
mini-app is its own tiny `.app` bundle (own Dock icon, indexed by Spotlight/Raycast/Launchpad),
rendering in a **system-WebKit `WKWebView`** — with **no bundled browser engine** — all talking to
**one shared Node backend** that owns the kernel, the Volume, the capabilities, and the agent.

- Research + design only — no code in this document.
- macOS only (cross-platform deferred).
- Reuses `@justfiles/app`, `@justfiles/agent`, `@justfiles/fs`, every `@justfiles/app-*` bundle, and `capnweb` — unchanged.
- The native shell is a tiny Swift "booter"; the backend is Node. **No Electron, no full Xcode** (Command Line Tools only).

**Contents**

1. [The reframe](#reframe)
2. [Process model](#process)
3. [The backend daemon (`quayd`)](#quayd)
4. [The native shells: booter + launcher](#shells)
5. [The app catalog & OS bundles](#catalog)
6. [Transport: Cap'n Web berths + localhost assets](#transport)
7. [Capabilities & the trust boundary](#caps)
8. [The agent](#agent)
9. [app-code & devkit](#appcode)
10. [Lazy loading & memory](#memory)
11. [Reused vs. new](#reuse)
12. [Open questions](#open)

<a id="reframe"></a>

## 1 · The reframe

frieren is two kernels over a synced volume (browser tab + Durable Object). `quay` keeps the
single-host idea but moves the boundary again: the host is a **standalone Node daemon**, and each app GUI
is a **separate native process** hosting a `WKWebView`. That separation is the whole point — it buys each mini-app a **real OS
identity** (Dock icon, Spotlight entry, Cmd-Tab) that Electron cannot give per-window, while the daemon
keeps everything singular and trusted.

Three forces shape the design:

- **OS identity needs a process.** On macOS a Dock icon / app menu / Cmd-Tab entry is welded to one
  process that owns the window. So a per-app Dock icon ⟹ a per-app process. We make that process a
  **tiny Swift booter** hosting a `WKWebView`, not a Chromium instance.
- **No bundled engine.** `WKWebView` renders with the OS's WebKit. N apps ship **zero** browser bytes
  (~tens of KB each) and use ~half the RAM of an Electron window. The cost is WebKit's quirks (handled
  by design — see §6/§7); the engine version tracks the OS.
- **One trusted host.** The kernel, the app **reducers** (sandboxed), the **capabilities**, and the
  **agent** all run in the Node daemon. **Nothing trusted runs inside Safari.** The webview only renders
  `gui.js` and forwards user intents over an RPC session.
- **App records live in the Volume and project to the OS.** The canonical install set is the kernel's
  `/applications` tree. A hosted app keeps its manifest and reducer there; the daemon mounts its GUI,
  icon, and other assets through `/private/cache/apps`. A local app with no download source keeps its
  full bundle in `/applications`. Each `.app` under `~/Applications/Quay Apps/` is a per-device
  **projection** of that catalog and never syncs. A later synced Volume can move installed records and
  complete local bundles between hosts without moving reconstructible hosted assets.

`quay` is, in the DESIGN.md §2 sense, just **another host**: it supplies four seams — a **Volume**
(native FS), a **`GetSandbox`** (`worker_threads`), a **`Capabilities`** registry, and a cached
**`FetchAsset`** for hosted files. The platform layer is already extracted into shared packages
(`@justfiles/app`, `@justfiles/agent`, `capnweb`), so `quay` is mostly assembly.

<a id="process"></a>

## 2 · Process model

```
┌──────────────────────────────────────────────────────────────────┐
│ Quay.app   (Swift · LSUIElement · global hotkey)                   │
│   WKWebView → launcher UI (app grid + fuzzy search + agent chat)   │
│   ── ensures quayd is up, then is just a privileged client ──      │
└───────────────────────────────┬──────────────────────────────────┘
                                │  ws://127.0.0.1:PORT  (Cap'n Web)
┌───────────────────────────────▼──────────────────────────────────┐
│ quayd — the Node backend daemon · single host · single writer     │
│   • kernel (dispatch queue · /applications · /state)              │
│   • capability registry  (volume · ai · devkit · …)  ← all here   │
│   • nodeSandbox → worker_threads  (lazy, content-addressed)       │
│   • pi agent  (@justfiles/agent)                                  │
│   • http: serves gui.js · icons · shared-React importmap          │
│   • Volume → fsStore(~/Library/Application Support/quay)          │
│   • hosted assets → /private/cache/apps                           │
└───────────────────────────────▲──────────────────────────────────┘
              ws (Cap'n Web) +   │   http (assets)
        ┌──────────────────────┼──────────────────────┐
┌───────▼───────┐      ┌───────▼───────┐      ┌────────▼──────┐
│ Code.app      │      │ Files.app    │      │ Paint.app     │  ← generated bundles in
│ Swift booter  │      │ Swift booter  │      │ Swift booter  │    ~/Applications/Quay Apps/
│  WKWebView    │      │  WKWebView    │      │  WKWebView    │    own Dock icon · Spotlight-indexed
│  gui.js only  │      │  gui.js only  │      │  gui.js only  │
└───────────────┘      └───────────────┘      └───────────────┘
```

Three process **types**:

| Process | Tech | Count | Owns |
|----|----|----|----|
| **Quay.app** (launcher) | Swift + WKWebView, `LSUIElement`, global hotkey | 1 | the launcher UI + agent chat; ensures `quayd`; privileged client |
| **quayd** (daemon) | Node | 1 | kernel, Volume, sandboxes, capabilities, agent, http/ws server |
| **`<App>.app`** (booter) | Swift + WKWebView | N (one per open app) | one app window + its `WKWebView`; scoped client |

The launcher and every booter are **clients** of `quayd` over a localhost socket. The launcher is the
one process that *spawns* mini-apps — and it does so via **LaunchServices** (`open <App>.app`), so each
mini-app starts as its own process with its own identity, not as a window of the launcher.

<a id="quayd"></a>

## 3 · The backend daemon (`quayd`)

One Node process is the entire trusted host. It is the **single writer** of the Volume.

```ts
// quayd — boot (sketch)
const root = `${os.homedir()}/Library/Application Support/quay/volume`
const fs = volume(fsStore(root))                             // real macOS folder
const capabilities = capabilityRegistry({ volume: volumeCapability(fs, { systemAllowlist }), /* ai, devkit */ })
const fetchAsset = await appAssets(fs)                         // cache-first hosted files
const kernel = createKernel({ fs, sandbox: nodeSandbox(), capabilities, fetchAsset })
await refreshApps(kernel, fs, true)                            // packaged + JustApps
const agent = await createAgentRuntime({ volume: fs, llm, appController })  // @justfiles/agent
serve({ kernel, agent })                                     // localhost http (assets) + ws (Cap'n Web)
```

What lives here and why it must be singular:

- **Kernel** — owns `/applications`, `/state`, the per-app serialized dispatch queue, commands,
  procedures, and capability-fed subscriptions. Emits `app.update`.
- **Volume** — `fsStore` over `~/Library/Application Support/quay/volume`. Everything frieren
  keeps in a synced volume is now a real folder you can open in Finder (`/applications`, `/state`,
  `/data/<id>`, `/system` for the agent's memory). `/private/cache/apps` is local derived data and is
  outside sync.
- **Sandboxes** — `nodeSandbox()` runs each app's `app.js` reducer in a `worker_thread`, keyed by code
  SHA. Lazy + evictable (§10). Reducer code never runs on the daemon's main thread, and never in a webview.
- **Capabilities** — the whole registry is local Node (§7). No Cap'n Web proxy for capabilities.
- **Agent** — `@justfiles/agent` runtime + tools + bash, with a `quay` `AppController` that opens/closes
  real app bundles (§8).
- **Server** — localhost `http` reads app files through the kernel, so local bundles and hosted cache
  entries use one route. The `ws` endpoint speaks Cap'n Web (§6).

**Discovery & lifecycle.** `quayd` writes `~/Library/Application Support/quay/runtime.json`
(`{ port, token, pid }`) on boot. Any client (launcher or booter) reads it; if it is absent or stale,
the client spawns `quayd` and waits for the file. This makes the daemon **ensure-running on demand** —
launching a mini-app from Spotlight while the launcher is closed still works. A single-writer lockfile
guarantees only one `quayd`. The daemon idle-exits when nothing is connected.

<a id="shells"></a>

## 4 · The native shells: booter + launcher

Both are the **same ~100-line Swift program** in two modes, validated by an earlier 84 KB `.app` POC
(recognised as a real Application, spawning the system `com.apple.WebKit.WebContent` process — zero bundled engine).

**The booter** (per mini-app). Reads its own app id from a custom `Info.plist` key (`QuayAppId`),
finds-or-spawns `quayd`, opens a window, and loads
`http://127.0.0.1:PORT/app/<id>?token=<one-time>` in a `WKWebView`. That's all — **the booter holds no
app logic and no assets**; it is a dumb window with an OS identity. One compiled binary is copied into
every generated `.app`; bundles differ only in `Info.plist` (bundle id, name, `QuayAppId`) and icon.
Bundle ids: the launcher is `app.justfiles.quay`; each mini-app is `app.justfiles.quay.app.<id>`.

**Window geometry persists natively.** The booter gives its `NSWindow` a frame-autosave name, so macOS
writes the window's position + size to that app's defaults on every move/resize and restores them on the
next launch — no daemon, no Volume, no code beyond the autosave call. Because every mini-app is its own
bundle (own `CFBundleIdentifier` ⟹ own `NSUserDefaults` domain), one constant autosave name is already
per-app; first launch (no saved frame) falls back to a centred default-size window. Geometry is the one
piece of state that is genuinely *device-local* (a frame from a 6K display is meaningless on a 13″
laptop), so it deliberately lives in per-device defaults, **not** the syncable Volume.

**The launcher** (`Quay.app`). An `LSUIElement` agent (no Dock icon) with a global hotkey
(`Option+Space`) that toggles a frameless, vibrancy-blurred panel. The panel is a `WKWebView`
showing the launcher UI: the app grid (from `quayd`'s `kernel.list()`), fuzzy search, and the agent
chat. Picking an app calls `NSWorkspace.open(<App>.app)` — **launching by bundle, not by window**, which
is what gives each app its own Dock identity. v1 launches only `quay`'s own apps; later the same surface
can `open` any `/Applications` app or run commands (a real Raycast-style launcher).

**WKWebView hardening.** Load only the localhost origin; deny file URLs and off-origin navigation; set a
CSP; `isInspectable = true` only in dev (gives full Safari Web Inspector). The shell refuses to render
anything but its app.

<a id="catalog"></a>

## 5 · The app catalog & OS bundles

Two notions of "installed" — a **canonical, syncable** one and a **local projection** — kept in lock-step
by a **one-way** reconcile:

- **Source of truth = the Volume.** `kernel.list()` reads canonical installed records from
  `/applications`. A hosted record contains its manifest, reducer, immutable source URL, and file
  hashes. Its mounted files stay in the local `/private/cache/apps` lane. A local app contains its full
  bundle. The launcher lists both shapes through the same kernel API.
- **OS bundles = a local projection.** So *other* launchers (Spotlight, Raycast, Launchpad, Alfred) can
  find and launch apps, `quayd` materialises a **thin** `.app` per installed app into
  `~/Applications/Quay Apps/` — Chrome's PWA-shim pattern. Each bundle is the shared booter binary + a
  per-app `Info.plist` + the app icon — **no app code** (the daemon reads local bundle bytes or verified
  hosted cache bytes and serves them over http, §6). Ad-hoc signed (`codesign -s -`; locally created ⟹
  no quarantine ⟹ Gatekeeper-clean) and registered with `lsregister`. The projection is **derived,
  never a second source of truth**, and is regenerated per device — so it never needs to sync.

A **one-way** reconcile (Volume → OS) keeps `~/Applications/Quay Apps/` in lock-step with `kernel.list()`:
install (local *or* synced-in) → write bundle; uninstall → remove; update → refresh icon/name. This is the
desktop analogue of frieren's `catalog:changed`. Because it is one-directional, there is no two-store
coherence problem — the Volume always wins.

> A fresh device starts with trusted hosted JustApps entries.
> Code remains the bootstrap for local apps. A local Code app keeps its full bundle because it has no
> immutable source URL.

<a id="transport"></a>

## 6 · Transport: Cap'n Web berths + localhost assets

The webview ⇄ kernel boundary is the one genuinely new channel. `capnweb` (already a dep of
`@justfiles/app`) is the right tool: the GUI gets a typed RPC stub to a **berth** — a per-connection,
token-scoped session object on `quayd`:

```ts
// the berth a webview is handed (conceptual)
interface Berth {
	dispatch(message): Promise<void>      // → kernel.dispatch(appId, message)
	subscribe(onState): Disposable        // callback passed over the wire (Cap'n Web)
	state(): Promise<AppState>            // → kernel.state(appId)
}
```

- **Assets over localhost http.** The booter loads `http://127.0.0.1:PORT/app/<id>/`. `127.0.0.1` is a
  *secure context*, so `localStorage`/`IndexedDB`/ES-modules/importmap all work — dodging WebKit's
  opaque-origin storage quirk. `quayd` reads `gui.js` and icons through `kernel.app(id).read(path)`.
  Hosted reads use the cache-first `FetchAsset`; local reads use the complete Volume bundle. The
  localhost response can stay `no-store` because WebKit cache state is not the durability layer. The
  booter writes **no** asset code.
- **The `defineGUI` mount reused verbatim.** frieren mounts a GUI with a `Transport = { invoke, subscribe }`; here
  `invoke`→`berth.dispatch`, `subscribe`→`berth.subscribe`. Only the transport changes.
- **Token scoping.** `quayd` passes each booter a one-time token + app id as launch arguments; the
  webview presents the token on connect; `quayd` scopes that berth to **that one app**. The launcher's
  connection is **privileged** (list/launch/inspect all + drive the agent). This contains a malicious or
  compromised `gui.js`: it can at most drive its own already-capability-scoped reducer.

> **Where Cap'n Web is *not* used:** reducer→capability. The reducer runs in a `quayd` `worker_thread`
> and capabilities run in `quayd`'s main thread, so that call is **in-process** (the existing
> worker↔host bridge), never crossing a socket. Cap'n Web is for webview↔kernel and agent-UI↔agent only.

<a id="caps"></a>

## 7 · Capabilities & the trust boundary

Everything runs in-process in `quayd`; there is no capability proxy and no `_caps` socket:

```ts
const capabilities = capabilityRegistry({
	volume:       volumeCapability(fs, { systemAllowlist }),
	ai:           aiCapability(text),            // quayd calls the LLM directly
	devkit:       devkitCapability(fs, kernel, preview),  // §9
	// integrations: …                            // optional, talks to providers directly
})
```

The trust model is frieren's, preserved: apps declare capabilities in `defineApp`; the kernel attaches
the *declared, trusted* scopes to each call (the worker isolate never supplies its own); `volume` scopes
are `app → /data/<id>`, an explicit `/prefix → that subtree`, `system → root` only for allow-listed apps.

The **trust boundary** is explicit and is the reason for the whole topology:

| Layer | Process | Trust |
|----|----|----|
| `gui.js` | the webview (Safari/WebKit) | **untrusted** — render + forward intents only; token-scoped to one app |
| `app.js` reducer | a `quayd` `worker_thread` | **untrusted but capability-scoped** — no ambient FS/network |
| kernel · registry · agent | `quayd` main thread | **trusted** |

"I don't trust Safari for capabilities" is satisfied by construction: no capability code, and no trusted
logic, ever runs in a webview.

<a id="agent"></a>

## 8 · The agent

`@justfiles/agent` (already extracted) runs in `quayd`: the `pi-agent-core` runtime, the fs/fetch/search
tools, the bash registry, and `createAppCommand` over an `AppController`. `quay` supplies an
`AppController` whose `launch`/`close` drive **real app bundles**:

```ts
const controller: AppController = {
	list:    () => kernel.list(),
	inspect: (id) => ({ ...manifest, state: kernel.state(id), actions: kernel.actions(id) }),
	state:   (id) => kernel.state(id),
	run:     (id, action, params) => kernel.dispatch(id, { type: action, params, actor: 'agent' }),
	launch:  (id) => { openAppBundle(id); return inspect(id) },   // NSWorkspace.open(<App>.app)
	close:   (id) => closeAppWindow(id ?? focusedAppId()),
	current: () => inspect(focusedAppId()),
}
```

**Coherence.** The agent dispatches into the **same kernel** the webviews subscribe to, so an
`app.update` fans out over each app's Cap'n Web berth immediately — no sync, no watch. (One hop over a
localhost socket, vs frieren's sync-down + file-watch.) The agent UI lives in the launcher and is
reused verbatim via its transport-agnostic `SocketLike`, here backed by a Cap'n Web socket.

<a id="appcode"></a>

## 9 · app-code & devkit

`@justfiles/app-code` ("Code") is the seeded built-in and the way apps get built/installed. Its power is
the `devkit` capability: read a project's `src/*` off the Volume, compile `app.ts`/`gui.tsx` with native
esbuild, and either install a finished bundle into `/applications` or mount a live preview.

- **Compile + install + pack** are pure data transforms over the Volume + injected esbuild — reused from
  `@justfiles/app/devkit`. `install` writes the complete local bundle to `/applications/<id>` because
  the draft has no immutable download source. It fires `onInstalled` →
  `quayd` **materialises the `.app` bundle** (§5) and re-lists. No change to app-code's reducer.
- **Live preview** (`devkit.run`) is the one bespoke, deferred seam: frieren mounts the draft into its
  own DOM, which has no in-process home here (kernel in `quayd`, code app in a separate webview). Ship
  compile/install/pack first; add a preview (a second `WKWebView` the code shell positions over a slot)
  later.

<a id="memory"></a>

## 10 · Lazy loading & memory

Memory stays bounded without keeping every app's code resident:

- **Reducers are lazy.** A `worker_thread` for an app is instantiated only on first dispatch/launch
  (content-addressed by code SHA — the kernel already does this). Nothing is in RAM until invoked.
- **Idle eviction.** Tear down a reducer's worker when its app has no open window and has been idle for
  N minutes; re-spawn on next dispatch. State is durable on disk (`/state/<id>.json`), so eviction is
  transparent. (Apps that must tick headlessly opt out.)
- **GUIs are per-window.** `gui.js` is fetched on demand and lives only in the open webview; closing the
  window frees it and quits the booter process. Hosted GUI bytes remain in the daemon's bounded local
  cache for offline launch.

A nice consequence: a mini-app's **state outlives its window**. Close the window → the booter exits and
the worker may evict, but `/state/<id>.json` persists; reopening rehydrates.

<a id="reuse"></a>

## 11 · Reused vs. new

**Reused (already in the monorepo — no copy):**

- `@justfiles/app` — kernel, SDK, `defineGUI`, `kernelHost` build, `volumeCapability`, `reconcileBuiltins`, devkit; depends on `capnweb`.
- `@justfiles/agent` — runtime, tools, bash, `createAppCommand` + `AppController`.
- `@justfiles/fs` — `volume`, `fsStore`, `chroot`.
- Every `@justfiles/app-*` bundle (counter, files, paint, settings, code, …) — as-is.
- The agent React UI (transport-agnostic via `SocketLike`).

**New for `quay` (small):**

- `quayd` — the daemon: server (http assets + Cap'n Web ws), discovery/lockfile, berth sessions, token scoping.
- `nodeSandbox()` — `GetSandbox` over `worker_threads` (the same protocol frieren's sandboxes use), with idle eviction.
- The Swift **booter/launcher** (one binary, two modes) + global hotkey + the launcher web UI.
- **OS-bundle materialisation** — generate/sign/register **thin** `.app` shims (no app code) in `~/Applications/Quay Apps/`, reconciled one-way to `kernel.list()`.
- The desktop `AppController` (open/close real bundles) + a Cap'n Web `SocketLike` for the agent UI.
- Root selection + first-run built-in seed from packaged resources.
- A cache-first `FetchAsset` under `/private/cache/apps` for hosted GUI, icon, and asset files.
- *Later:* the `WKWebView` live-preview for app-code.

<a id="open"></a>

## 12 · Open questions

- **Backend lifecycle policy.** When exactly does `quayd` exit — last client disconnect + idle timeout?
  Who supervises it (the launcher vs a LaunchAgent)? Start with ensure-running + idle-exit; revisit.
- **Multi-window of one app.** v1 is deliberately **one window per app**: a macOS re-`open` of a running
  `.app` just activates the existing booter (LaunchServices' default), which maps cleanly onto the per-app
  frame-autosave (§4) and the single per-app Dock identity. Two routes open it up later, each with a
  trade-off:
    - **`open -n` (a new process per window).** Each window is its own booter process, so it keeps a real
      OS identity and crash isolation — but the windows share one bundle id, hence one `NSUserDefaults`
      domain, so the single frame-autosave name would **collide** (every window saving/restoring the same
      frame). Each window then needs its own autosave name (an indexed `quayWindow.<n>`) or a cascade.
    - **In-shell multi-window (one booter, N `NSWindow`s).** Cheaper — one process, one ws connection, a
      natural home for a "New Window" menu item — but every window shares one Dock icon and one crash
      domain. Geometry stays per-`NSWindow` via distinct autosave names or AppKit's built-in cascade.

  Either route, the windows are all **clients of the same kernel state**: each opens its own token-scoped
  Cap'n Web berth onto the same `appId`, so an `app.update` fans out to every open window and they
  live-sync with no extra machinery. The cost of multi-window is entirely in native window/identity
  management, **not** in state. Likely landing: in-shell windows for a plain "New Window", reserving
  `open -n` for the rare app that genuinely needs a separate OS identity per window; open is whether the
  launcher or `quayd` brokers the window count.
- **Projection drift.** A user dragging a materialised `.app` to the Trash is a delete the Volume never
  authorised. v1: the next reconcile re-materialises it (Trash is *not* uninstall); later, optionally watch
  `~/Applications/Quay Apps/` and treat a Trash as a real uninstall — the one tolerated `.app` → Volume edge.
- **Native-touching capabilities.** Notifications, clipboard, "reveal in Finder", dialogs live in
  `quayd` but need a native affordance — route through a small native helper or the relevant shell when they arrive.
- **Crash/reconnect.** Booter behaviour on `quayd` drop (reconnect UI + re-ensure). Reducer-worker crash
  is already isolated by the kernel.
- **Live preview fidelity.** Confirm the second-`WKWebView` preview approach; slot geometry on resize/HiDPI.
- **Signing / notarisation.** Deferred. Ad-hoc signing suffices for local install; notarisation (needs
  `notarytool`, i.e. full Xcode) is only for public distribution.

------------------------------------------------------------------------

Cross-references: `packages/fs/{volume,storage.fs}.ts` · `packages/app/{kernel,react,vite}.ts` +
`capnweb` · `packages/agent/*` · `@justfiles/app-code`.

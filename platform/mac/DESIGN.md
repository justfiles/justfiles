# Just Computer for Mac — design

The Mac host runs the same apps as the web client (`platform/frieren`), but as **real macOS
apps**: each app is its own thin `.app` bundle with its own Dock icon, found by
Spotlight, Raycast and Launchpad. Each one renders in a **system-WebKit `WKWebView`**, with
no bundled browser engine. All of them talk to **one Bun daemon** that owns the kernel, the
Volume, the capabilities and the agent.

- macOS on Apple Silicon only.
- Reuses `@justfiles/app`, `@justfiles/agent`, `@justfiles/fs`, `@justfiles/ui` and every
  published app bundle unchanged.
- The native shell is a small Swift program built with SwiftPM. **No Electron, no full
  Xcode** (Command Line Tools only).

How to build and run it is in [README.md](./README.md).

**Contents**

1. [The reframe](#reframe)
2. [Process model](#process)
3. [The daemon](#daemon)
4. [The native shell: launcher and booter](#shell)
5. [The app catalog and OS bundles](#catalog)
6. [Transport](#transport)
7. [Capabilities and the trust boundary](#caps)
8. [The agent](#agent)
9. [Devkit](#devkit)
10. [Lazy loading and memory](#memory)
11. [Open questions](#open)

<a id="reframe"></a>

## 1 · The reframe

The web client is two kernels over a synced Volume (browser tab and Durable Object). The Mac
host keeps one kernel, in a **standalone daemon**, and makes each app GUI a **separate
native process** hosting a `WKWebView`. That separation is the point: it gives each app a
**real OS identity** (Dock icon, Spotlight entry, Cmd-Tab), which Electron cannot give per
window, while the daemon keeps everything singular and trusted.

Four forces shape the design:

- **OS identity needs a process.** On macOS a Dock icon, app menu and Cmd-Tab entry belong
  to the process that owns the window, so a per-app Dock icon means a per-app process. That
  process is a **tiny Swift booter** hosting a `WKWebView`, not a Chromium instance.
- **No bundled engine.** `WKWebView` renders with the OS's WebKit. The app bundles ship no
  browser bytes; the engine version tracks the OS.
- **One trusted host.** The kernel, the app reducers (sandboxed), the capabilities and the
  agent all run in the daemon. **Nothing trusted runs in a webview.** A webview renders
  `gui.js` and forwards user intents.
- **App records live in the Volume and project to the OS.** The canonical install set is the
  kernel's `/applications` tree. Each `.app` under `~/Applications/Just Computer Apps/` is a
  per-device **projection** of it and never syncs.

The Mac host is, in kernel terms, just another host: it supplies a **Volume** (a native
folder, synced when signed in), a **`GetSandbox`** (worker threads), a **capability
registry**, and a cached **`FetchAsset`** for hosted app files.

<a id="process"></a>

## 2 · Process model

```
┌──────────────────────────────────────────────────────────────────┐
│ Just Computer.app   (Swift · LSUIElement · Option+Space)           │
│   AppKit panel: app grid + composer                               │
│   WKWebViews: chat transcript · App Store · Settings              │
│   ── spawns the daemon if needed, then is a client of it ──      │
└───────────────────────────────┬──────────────────────────────────┘
                                │  http + ws  127.0.0.1:PORT
┌───────────────────────────────▼──────────────────────────────────┐
│ daemon — Bun · single host · single writer                        │
│   • kernel (dispatch queue · /applications · /state)              │
│   • capability registry (volume · devkit · ai · email · …)        │
│   • reducer sandboxes → worker threads (lazy, idle-evicted)       │
│   • agent (@justfiles/agent)                                      │
│   • http: app shell · gui.js · icons · launcher surfaces          │
│   • Volume → ~/Library/Application Support/Just Computer          │
│   • hosted app files → /private/cache/apps                        │
└───────────────────────────────▲──────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
┌───────▼───────┐       ┌───────▼───────┐       ┌───────▼───────┐
│ Files.app     │       │ Notes.app     │       │ Paint.app     │  ← generated bundles in
│ Swift booter  │       │ Swift booter  │       │ Swift booter  │    ~/Applications/Just Computer Apps/
│  WKWebView    │       │  WKWebView    │       │  WKWebView    │
└───────────────┘       └───────────────┘       └───────────────┘
```

| Process | Tech | Count | Owns |
|----|----|----|----|
| **Just Computer.app** (launcher) | Swift, AppKit + WKWebView, `LSUIElement` | 1 | the panel, the chat, the App Store and Settings surfaces |
| **daemon** | Bun | 1 | kernel, Volume, sandboxes, capabilities, agent, http/ws server |
| **`<App>.app`** (booter) | Swift + WKWebView | one per open app | one app window |

The launcher and every booter are **clients** of the daemon over loopback. The launcher
opens an app through **LaunchServices** (`open <App>.app`), so each app starts as its own
process with its own identity, not as a window of the launcher.

<a id="daemon"></a>

## 3 · The daemon

One Bun process is the entire trusted host and the **single writer** of the Volume
(`daemon/main.ts`, `daemon/kernel.ts`). In a shipped build it is one self-contained
executable at `Just Computer.app/Contents/MacOS/daemon`.

- **Kernel**: owns `/applications`, `/state`, the per-app serialized dispatch queue,
  procedures and capability-fed subscriptions.
- **Volume**: under `~/Library/Application Support/Just Computer`. Signed out, it is
  local-only. Signed in, it syncs with the user's cloud store. Signing out keeps the
  Volume; a different account signing in replaces it (`daemon/fs.ts`).
  `/private/cache/apps` is local derived data and never syncs.
- **Sandboxes**: each app's reducer runs in a worker thread (`daemon/sandbox.ts`). Reducer
  code never runs on the daemon's main thread or in a webview.
- **Capabilities**: the whole registry runs in the daemon (§7).
- **Agent**: `@justfiles/agent`, with an app controller that opens and closes real app
  bundles (§8).
- **Server**: `Bun.serve` on `127.0.0.1` only. Shipped builds take an OS-assigned port;
  dev uses 3000 so an open tab survives `bun --watch` restarts.

**Discovery and lifecycle.** On boot the daemon takes `daemon.lock` (one daemon per user)
and writes `runtime.json` (`{ port, token, pid }`) beside the Volume. A client reads it; if
it is missing or stale, the client spawns the daemon with the runtime its own `Info.plist`
names (`DaemonRuntime`, `DaemonArgs`, `DaemonScript`) and waits for the file. So launching an
app from Spotlight with the launcher closed still works. A daemon the launcher spawned
watches the launcher's PID (`FRIEREN_OWNER_PID`) and exits when the launcher quits.

<a id="shell"></a>

## 4 · The native shell: launcher and booter

Both are **one Swift binary in two modes** (`native/Sources/shell/main.swift`): with an
`AppId` in its `Info.plist` it is a booter, without one it is the launcher.

**The booter** (one per app). Reads its app id, finds or spawns the daemon, opens a window,
and loads `http://127.0.0.1:PORT/app/<id>` in a `WKWebView`. It holds **no app logic and no
assets**: it is a window with an OS identity. The same compiled binary is copied into every
projected `.app`; bundles differ only in `Info.plist` and icon.

**Window geometry persists natively.** The booter gives its `NSWindow` a frame-autosave
name, so macOS saves position and size to that app's defaults and restores them on the next
launch. Each app is its own bundle (own `CFBundleIdentifier`, own defaults domain), so one
constant name is already per app. Geometry is device-local by nature, so it lives in
per-device defaults, not the synced Volume.

**The launcher** (`Just Computer.app`, bundle id `app.justfiles.frieren.host`). An
`LSUIElement` agent (no Dock icon) whose global hotkey, **Option+Space**, toggles a
floating, vibrancy-blurred panel. The grid, search results and composer are native AppKit.
The chat transcript, the App Store and Settings are React surfaces the daemon serves,
embedded in transparent `WKWebView`s. Picking an app calls `NSWorkspace.open(<App>.app)`:
launching by bundle, not by window, is what gives each app its own Dock identity.

**Notifications.** The `notify` capability and the agent fan notifications out over the
launcher's socket; the launcher posts them through `UNUserNotificationCenter`
(`Notifier.swift`) and routes a banner click back to the chat, an app or Settings.

<a id="catalog"></a>

## 5 · The app catalog and OS bundles

Two notions of "installed", a **canonical** one and a **local projection**, kept in step by
a **one-way** reconcile.

- **Source of truth: the Volume.** `kernel.list()` reads installed records from
  `/applications`. A hosted app (from JustApps) keeps its manifest and reducer there; the
  daemon downloads its GUI, icon and other files into `/private/cache/apps/<sha256-of-url>`
  and checks them against the manifest's hashes. A local app (for example one installed from
  Code) has no download source, so it keeps its full bundle in the Volume.
- **OS bundles: a local projection.** So that Spotlight, Raycast, Launchpad and Alfred can
  find apps, the daemon writes a **thin** `.app` per installed app into
  `~/Applications/Just Computer Apps/` (`daemon/materialize.ts`): the shared booter binary, a
  per-app `Info.plist` and the icon, and **no app code**. Bundles are ad-hoc signed
  (`codesign -s -`; created locally, so never quarantined) and registered with `lsregister`.

The reconcile runs Volume → OS only: install writes a bundle, uninstall removes it, a change
refreshes it. The Volume always wins, so there is no two-store coherence problem.

**Bundle ids.** A first-party id (`justfiles.*`) is used verbatim as the `CFBundleIdentifier`.
Any other id is namespaced as `app.justfiles.frieren.ext.<id>`, so a community app can never
shadow a real installed app in LaunchServices.

**What a fresh Volume gets.** The apps `daemon/builtins.ts` lists in `SEEDED` (Files, Notes,
Paint). Everything else installs from the launcher's App Store tile, after a consent sheet
that shows the access the release declares (see the README).

<a id="transport"></a>

## 6 · Transport

Everything is plain HTTP and WebSockets with JSON messages on the daemon's loopback origin:

| Route | Kind | Carries |
|----|----|----|
| `/app/:id` | http | the app shell, which loads `/app/:id/gui.js` |
| `/app/:id/gui.js`, `/app/:id/icon` | http | read through the kernel, so local bundles and hosted cache entries share one route |
| `/app/:id/connect` | ws | the GUI's dispatches (request/response) and state frames for that app |
| `/system` | ws | the launcher's catalog, slash commands and notifications |
| `/agent`, `/agent/:id` | ws | the launcher's agent session, and the agent attached to one app |
| `/store`, `/store/:id` | http | the App Store listing, and an install (POST) |
| `/api/settings/:method` | http | Settings calls; needs the bearer token from `runtime.json` |

`127.0.0.1` is a secure context, so `localStorage`, IndexedDB and ES modules all work in the
webviews. The GUI mounts with the same `defineGUI` code as on the web; only the transport
under it differs.

The reducer-to-capability call never crosses a socket: the reducer runs in a daemon worker
thread and capabilities run on the daemon's main thread, so that call is the in-process
worker bridge.

<a id="caps"></a>

## 7 · Capabilities and the trust boundary

The whole registry runs in the daemon (`daemon/kernel.ts`): `volume`, `devkit`, `ai`,
`email`, `calendar` and `notify`. Credentials for connected accounts are sealed at rest
with a key kept in the Keychain.

The trust model is the web client's: apps declare capabilities in `defineApp`, and the
kernel attaches the declared scopes to each call (the worker never supplies its own).
`volume` scopes are `app → /data/<id>`, an explicit `/prefix → that subtree`, and
`system → root` only for allow-listed apps.

| Layer | Process | Trust |
|----|----|----|
| `gui.js` | a webview | **untrusted**: renders and forwards intents |
| `app.js` reducer | a daemon worker thread | **untrusted but capability-scoped**: no ambient file system or network |
| kernel, registry, agent | daemon main thread | **trusted** |

No capability code and no trusted logic runs in a webview.

**Known gap.** Every app document is served from the daemon's origin, so an app's page is
same-origin with the launcher and can open any daemon socket or call the install route.
The daemon rejects cross-origin POSTs, which stops other websites, but not other apps.
Closing this needs app documents on their own origin (§11).

<a id="agent"></a>

## 8 · The agent

`@justfiles/agent` runs in the daemon with its tools and an app controller from
`@justfiles/app` (`createAppController`). The Mac host supplies the window port: opening an
app runs `open <App>.app`, closing it quits that bundle (`daemon/agent.ts`).

The agent dispatches into the **same kernel** the webviews subscribe to, so an action it runs
fans out to every open window of that app straight away, with no sync step in between.

<a id="devkit"></a>

## 9 · Devkit

The Code app builds apps through the `devkit` capability: read a project off the Volume,
compile and typecheck it, then install it or run a preview.

- **Compile and typecheck** run in a warm worker thread the daemon spawns on first use
  (`daemon/toolchain.ts`). The worker is embedded in the shipped executable, so no external
  toolchain is needed.
- **Install** writes the complete bundle to `/applications/<id>`, since a draft has no
  download source. The projection then writes its `.app`.
- **Preview** installs the draft under a preview id and returns `/app/<previewId>`, which
  Code embeds in its preview pane (`makeRunner` in `daemon/kernel.ts`).

<a id="memory"></a>

## 10 · Lazy loading and memory

- **Reducers are lazy.** An app's worker starts on first dispatch or launch, keyed by its
  code.
- **Idle eviction.** Three minutes after an app's last window closes, its worker is stopped
  (`daemon/sandbox.ts`). State is on disk (`/state/<id>.json`), so the next dispatch starts
  a fresh worker transparently.
- **GUIs are per window.** `gui.js` lives only in the open webview; closing the window quits
  the booter. Hosted GUI files stay in the daemon's local cache, so apps launch offline.

So an app's **state outlives its window**: closing it ends the booter and may evict the
worker, but reopening rehydrates from `/state/<id>.json`.

<a id="open"></a>

## 11 · Open questions

- **App documents off the daemon origin.** The gap in §7. One option is a per-app origin
  with per-caller authorization on the loopback surface.
- **Multi-window of one app.** Today it is one window per app: re-opening a running `.app`
  activates the existing booter. `open -n` (a process per window) keeps OS identity but
  makes the windows share one defaults domain, so the frame-autosave names would collide.
  Several `NSWindow`s in one booter is cheaper but shares one Dock icon. Either way the
  windows are clients of the same kernel state, so the cost is native window management,
  not state.
- **Projection drift.** Dragging a projected `.app` to the Trash is a delete the Volume never
  authorised; the next reconcile writes it back. Treating the Trash as an uninstall would
  be the one OS → Volume edge.
- **Distribution.** Builds are ad-hoc signed and arm64 only. Notarisation (which needs full
  Xcode) and x64 or universal builds are not set up.

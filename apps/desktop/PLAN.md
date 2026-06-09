# desktop — bootstrap plan

A windowless, background-running, Raycast-style launcher built on Electron.
Each `@justfiles/app-*` package eventually opens in its own native window,
reusing the same kernel + capabilities + GUI shim machinery frieren uses today.
macOS first, cross-platform later. Auto-update nice-to-have, deferred.

> Ground rules (`CLAUDE.md`): keep code minimal; tab indentation; minimum
> dependencies; prefer composing existing packages. After each slice:
> `pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test`.

## Intention

frieren is the web shell — one tab, internal routing between apps.
**desktop** is the native shell — no tab, no chrome, just:

1. A **global hotkey** (e.g. `Option+Space`) summons a translucent launcher
   panel centred on the active display. No Dock icon, no menu bar by default.
2. The launcher lists installed apps. Pick one → it opens in **its own
   `BrowserWindow`**. Close that window, the app goes away. The launcher and
   other open apps keep running.
3. Each app window is a Chromium renderer running the same React/kernel stack
   frieren mounts today — `@justfiles/app` boots, the chosen app-\* package
   loads through the existing GUI shim. Capabilities are granted by the
   main-process host instead of frieren's worker.

This plan covers **only the shell**: the windowless launcher, hardcoded app
list, and one blank `BrowserWindow` per "launch". Kernel wiring, capabilities,
and real app mounting are deliberately out of scope and tracked separately.

## Visual reference: Sol

[ospfranco/sol](https://github.com/ospfranco/sol) is an OSS macOS launcher
written in Electron + React. It's the closest existing thing to what we want
visually and architecturally:

- Frameless, transparent, vibrancy-blurred panel.
- Global hotkey shows/hides.
- Hidden Dock icon (`LSUIElement`), runs as a macOS agent.
- Extensions render their own React UIs.

We're not forking Sol — but its `main.ts` window-management and BrowserWindow
flags are the reference. When in doubt, match Sol.

## Stack decision: electron-vite + electron-builder

Researched in chat 2026-06-09. Summary:

| Option                                          | Verdict                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Electron Forge (Vite template)**              | Official, all-in-one, but Vite plugin still marked **experimental** in v7.5+. Pulls many `@electron-forge/*` packages. Heavier than we need.                                                                                                    |
| **electron-vite (alex8088) + electron-builder** | **Chosen.** Two devDeps. Stable v5. Endorsed by the Vite team. Clean main/preload/renderer split. Reuses the Vite stack the monorepo already runs (`frieren`, `app-*`, `@tailwindcss/vite`). Multi-entry support fits the per-app-window model. |
| **vite-plugin-electron**                        | A Vite plugin to bolt Electron onto an existing Vite app. We want the inverse — Electron-first with Vite inside — so skip.                                                                                                                      |
| **electron-builder**                            | De-facto packager. More popular than Forge's makers, has `electron-updater` baked in for later. Standalone, no opinion on dev server.                                                                                                           |

### pnpm monorepo gotchas (known, addressable)

- electron-builder doesn't follow pnpm's symlinked `node_modules`. Fix: add
  `node-linker=hoisted` to `apps/desktop/.npmrc`. Standard, well-documented.
- The Electron postinstall downloads a binary — add `electron` to
  `pnpm-workspace.yaml`'s `allowBuilds`, same as `sharp` / `esbuild`.
- Workspace deps (`workspace:*`) work fine through the hoisted layout. When we
  eventually depend on `@justfiles/app` etc., electron-builder's `files` glob
  needs to include the hoisted modules — defer until that slice.

## Local dev: not awkward

A `BrowserWindow` is Chromium. `electron-vite dev` runs a normal Vite dev
server on `localhost:5173`; each window does `loadURL('http://localhost:5173/...')`
and gets full HMR + React Fast Refresh just like a browser tab. Main and
preload changes hot-restart the Electron process (~1s). DevTools open
per-window.

One ergonomic: the launcher is hidden by default. We'll `if (import.meta.env.DEV)
launcherWin.show()` so it stays visible while iterating.

---

## Slice 1 — Scaffold via CLI

**Goal:** a clean `apps/desktop` directory containing the electron-vite React

- TS scaffold, building and running with `pnpm dev` from inside the app dir.
  No customisation yet.

**Steps** (run from repo root unless noted):

```sh
# scaffold electron-vite into apps/desktop
# the CLI prompts for project name, framework, TS, updater plugin, mirror.
# answer: react, TypeScript yes, updater no (defer), mirror no.
# it will warn that the dir is non-empty (PLAN.md sits there) — accept.
pnpm create @quick-start/electron@latest apps/desktop -- --template react-ts

# pnpm postinstall needs electron in allowBuilds
# (edit pnpm-workspace.yaml — one line addition)
```

Then add the pnpm fix file (one line, no need to write package.json):

```sh
printf 'node-linker=hoisted\n' > apps/desktop/.npmrc
```

Install through the workspace so it shares the lockfile:

```sh
pnpm install
```

**Verify:**

```sh
cd apps/desktop
pnpm dev
```

A normal-Electron-windowed React app launches. HMR works when you edit the
renderer. We have not customised anything yet — this is just baseline.

---

## Slice 2 — Make it windowless on launch + global hotkey

**Goal:** start with no visible window and no Dock icon; `Option+Space`
toggles a frameless, transparent launcher panel that says "hello".

**Touches:** `apps/desktop/src/main/index.ts` only (electron-vite's main
entry). The renderer keeps the default React page for now.

Key APIs (from research, not pasting code yet — written during the slice):

- `app.dock?.hide()` on macOS; `LSUIElement: true` via electron-builder's
  `mac.extendInfo` later.
- `globalShortcut.register('Alt+Space', toggleLauncher)`.
- Launcher `BrowserWindow`: `frame: false`, `transparent: true`,
  `vibrancy: 'under-window'`, `visualEffectState: 'active'`,
  `alwaysOnTop: true`, `skipTaskbar: true`, `resizable: false`,
  `roundedCorners: true`, `show: false`. Centered via
  `screen.getCursorScreenPoint()` + `getDisplayNearestPoint()`.
- Dev convenience: `if (!app.isPackaged) launcherWin.show()`.

**Verify:** `pnpm dev` shows no Dock icon; the default React page appears as
a translucent frameless panel on `Option+Space`; pressing again hides it.

---

## Slice 3 — Hardcoded app list + blank-window launch

**Goal:** the launcher renders a list of apps (hardcoded array, no kernel,
no `@justfiles/*` deps yet). Clicking an item opens a new normal
`BrowserWindow` titled with the app name, body shows the app name. That's it.

**Touches:**

- `apps/desktop/src/renderer/src/App.tsx` — replace default React content with
  a simple list (name + click handler). Tailwind not required for slice;
  inline styles fine.
- `apps/desktop/src/main/index.ts` — IPC handler `launcher:open-app` that
  spawns a new `BrowserWindow` and loads either a `?app=<name>` URL on the
  dev server or a static placeholder HTML file in prod.
- `apps/desktop/src/preload/index.ts` — `contextBridge.exposeInMainWorld`
  exposing one method: `openApp(name: string)`.

Hardcoded list lives in one file (e.g. `src/shared/apps.ts`) so renderer +
main can both import it. Initial entries match existing packages so we have
real names on screen:

```ts
export const APPS = ['Code', 'Finder', 'Paint', 'Settings', 'Counter']
```

The "app window" renderer is the same Vite renderer entry with a query-param
branch: `?app=Paint` → render `<div>Paint</div>` instead of the launcher.
Single renderer, two views, decided by `window.location.search`. No new entry
files needed. (Multi-entry comes in the kernel-integration plan later.)

**Verify:** `pnpm dev`. `Option+Space` shows the launcher with 5 items.
Click "Paint" → new normal window opens titled "Paint" showing the word
"Paint". Click again → second "Paint" window. Close the launcher → app
windows stay open. `Cmd+Q` quits everything.

---

## Slice 4 — Production preview

**Goal:** confirm the production build behaves the same as dev (no dev server,
file:// loads, no Dock icon, hotkey works).

**Steps:**

```sh
cd apps/desktop
pnpm build           # electron-vite build
pnpm exec electron-builder --dir   # produces a .app bundle, no installer
open out/mac-arm64/desktop.app     # or whatever the output path is
```

**Verify:** the bundled `.app` launches as a background agent (no Dock icon),
`Option+Space` toggles the launcher, clicking an item opens a blank named
window. Gatekeeper will warn — that's expected unsigned; right-click → Open
to bypass for local testing. Signing/notarisation is a later slice.

---

## Not in this plan (deferred)

- Kernel integration: mounting `@justfiles/app` + a real app-\* package inside
  the per-app `BrowserWindow`. Needs its own plan — IPC capability transport,
  per-window kernel scoping, etc.
- Real launcher UI: search, fuzzy match, icons, Tailwind/design-system.
- Tray icon, login-item, accessibility prompts.
- Code signing, notarisation, auto-update via `electron-updater`.
- Windows/Linux polish (vibrancy is macOS-only — Win/Linux need a different
  blur/background path).
- App Store sandbox compatibility (`globalShortcut` is awkward under MAS).

## Open questions to resolve before Slice 1

- **Package name.** `@justfiles/desktop`? Match the existing `@justfiles/*`
  scope. The scaffold will write a default — we'll rename after.
- **Bundle id.** Need an `appId` for electron-builder later (e.g.
  `dev.justfiles.desktop`). Not blocking for slices 1–3.
- **Hotkey.** `Option+Space` proposed (avoids Spotlight on `Cmd+Space`).
  Confirm before Slice 2.

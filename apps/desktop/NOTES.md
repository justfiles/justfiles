# desktop — notes

## Electron binary fails to install on Node >= 24.16 (silent)

**Symptom:** `pnpm dev` throws `Error: Electron uninstall` from electron-vite.
Under the hood, `electron`'s `install.js` postinstall downloads the binary zip
fine but extraction stops after the first large entry — `dist/` ends up with
only `LICENSES.chromium.html`, no `path.txt`. The process exits **0** with no
error, so pnpm reports the postinstall as "Done". electron-vite then can't find
`path.txt` and throws.

**Root cause:** a Node.js classic-stream backpressure-resume regression
(works on 24.15.0, broken 24.16.0 → 26.x, still open). It stalls the 6-year-old
`extract-zip@2.0.1` → `yauzl@2` chain that `electron`'s installer uses. Same bug
hit Playwright / Cypress / Puppeteer / electron-builder. Not an Electron or
electron-vite bug.

- nodejs/node#63487 — "Node 24.16.0: extract-zip hangs extracting"
- max-mapper/extract-zip#154 — "Zip extraction fail in Node 26.1.0"

**Fix (in repo):** force the patched yauzl under extract-zip, via
`pnpm-workspace.yaml` (pnpm 11 ignores `pnpm.overrides` in package.json):

```yaml
overrides:
  'extract-zip>yauzl': '3.3.1'
```

Apply with `pnpm install --no-frozen-lockfile` (a plain `pnpm install` may
short-circuit with "Already up to date" and skip re-resolving the override).

**If it ever recurs** (override removed, or a stale partial extraction):

```sh
E=node_modules/.pnpm/electron@*/node_modules/electron
rm -rf $E/dist $E/path.txt && node $E/install.js
```

## Launcher window: plain BrowserWindow vs. nonactivating NSPanel

The launcher is modelled on [ospfranco/sol](https://github.com/ospfranco/sol),
whose panel is a native macOS `NSPanel` with the `.nonactivatingPanel` style
mask. A plain Electron `BrowserWindow` reproduces most of that behaviour, but
not the nonactivating part. We use a plain `BrowserWindow` and stay dep-free.

What the plain `BrowserWindow` already gives us (no deps):

- Floats over fullscreen apps and on every Space
  (`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`).
- Hides on blur and on Escape; closes the moment an app is launched.
- Frameless, transparent, vibrancy panel that resizes to fit its content.

The one gap: when summoned, the launcher **activates our (dock-hidden) agent and
deactivates whatever app you were just in**. Sol avoids this with a
nonactivating `NSPanel`, which in Electron needs a native addon such as
[`electron-panel-window`](https://github.com/yvbeek/electron-panel-window).

### Without the addon — plain BrowserWindow (current choice)

- **Pros:** zero dependencies (matches the minimal-deps rule); no native build
  step or extra electron-builder wiring; one code path that also works on
  Win/Linux (panels are macOS-only); less to break on Electron upgrades.
- **Cons:** summoning steals focus — the previously focused app is deactivated,
  so its caret/selection/inline state is lost while the launcher is open; the
  foreground app dims behind the panel, so it's slightly less Spotlight-like.

### With the addon — nonactivating NSPanel (`electron-panel-window`)

- **Pros:** full Spotlight/Raycast/Sol parity — takes keystrokes **without**
  deactivating the app underneath, so your cursor/selection stays put; more
  robust "floats above everything" via the real panel window level.
- **Cons:** a native macOS addon rebuilt against Electron's ABI and bundled
  through electron-builder's native-module handling (more packaging surface);
  macOS-only, so the code forks for Win/Linux; one more dependency to track for
  security and Electron-upgrade breakage, against the minimal-deps rule.

### Decision

Keep the plain `BrowserWindow`. Revisit the addon only if focus-stealing on
summon becomes an actual annoyance in daily use.

# GUI parity fixture

Run from the repository root:

```sh
node platform/frieren/scripts/gui-frame-probe.ts
node platform/frieren/scripts/gui-frame-probe.ts --serve
```

The first command checks Chromium and WebKit. The second keeps the standalone fixture open for
manual inspection. The fixture includes imported CSS and an SVG, host state, dialogs, a blob
download, a changing window title, and a second opaque-origin `srcdoc` iframe. That document
imports a blob module, keeps its own counter, and sends selected text to the GUI. It receives no
kernel client. Both documents report whether parent DOM access is blocked.

For host smoke checks, build these same `app.ts` and `gui.ts` entries and install their bundles in
a test Frieren profile or a Mac daemon with a temporary `FRIEREN_SUPPORT_DIR`. Keep the daemon's
`projectApps` callback disabled when using a temporary volume. In Frieren, check close/reopen and
reattachment as well as the controls. In the actual native Mac shell, also check the window title,
Escape from the GUI while an agent sheet is open, Command-W, the downloaded file, and reopening.
Browser WebKit does not replace this native check.

The September 2026 implementation checks passed in standalone Chromium/WebKit, the Frieren
window adapter with its browser kernel, and the actual Mac Booter/WKWebView against an isolated
daemon. No CSP adjustment was needed: `frame-src 'none'` and `child-src 'none'` remain in place;
the local document inherits the parent's script policy and runs its blob module.

Both scaffold templates were also installed outside the monorepo using a packed SDK. Their
checks, dev controls, persisted state, and React rebuild failure/recovery passed. Mapped React
imports were exercised from pinned esm.sh URLs in both browsers. The headless runtimes and
capability implementations remain host-specific. SDK publication follows the existing
release-please and `app-v*` tag workflow after this implementation is merged. Storage PR #645 is
already merged.

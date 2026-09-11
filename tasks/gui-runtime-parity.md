---
project: platform/apps
status: active
---

# Share the app GUI runtime across hosts

## Context and scope

Standalone apps should be developed against the same GUI environment they receive in Frieren and Mac, without needing a platform checkout. The immediate consumer is Learn: its GUI will render generated MDX as JavaScript inside a second, sandboxed material iframe. This is a generic app-host improvement, not a Learn-specific renderer.

At planning time, the [dev bootstrap](../packages/app/vite.ts) mounted Vite source modules directly into its page. [Mac](../platform/mac/ui/app/main.tsx) mounted built `gui.js` directly into the WKWebView page. [Frieren](../platform/frieren/src/apps/host.ts) loaded that bundle into an opaque-origin iframe with a restrictive CSP, now in the [shared frame](../packages/app/iframe.ts). Consequently, code that worked locally could fail when installed: different DOM access, script loading, networking, and nested-document restrictions.

Deliver GUI parity only. Keep the existing kernels, capability implementations, backend transports, and headless execution: Vite/Node in development, browser Workers in Frieren, Bun Workers on Mac. Headless parity, new capabilities, and agent execution are separate work. Persistent dev storage is covered by [PR #645](https://github.com/xiaoxinghu/justfiles/pull/645); preserve it when integrating.

## Concrete solution

**One SDK-owned frame.** Extend [packages/app/iframe.ts](../packages/app/iframe.ts), reusing `guiHost` and `guiFrameScript`. Move Frieren's document wrapper, sandbox flags, design stylesheet, and CSP into this shared implementation. All three hosts create the frame through one helper, tentatively `mountAppFrame`: supply a container, GUI bundle text, initial state, and the existing host callbacks; receive state-update and disposal operations. Keep policy fixed, with no app-controlled permissions or platform mode switch.

The app's existing `gui.mount` interface stays unchanged. Each host retains its outer window, agent panel, dialogs, and connection to the kernel. Its adapter forwards actions and state through the shared MessagePort bridge. Remounting closes the old port and starts a fresh frame from current state; old frames must not dispatch after disposal. Handle iframe reload/reattachment as well as explicit replacement, without duplicate boots or listeners.

**Development uses the shipped GUI build.** Reuse the production GUI build configuration in [packages/app/vite.ts](../packages/app/vite.ts), including CSS embedding and mapped imports. Watch sources, build the GUI bundle, and pass its bytes through the same frame loader as production. Keep Vite's connection and rebuild notifications in the outer host page. A successful build replaces the frame; a failed build shows a host-side error and leaves the last working frame available. Preserve reducer state, but do not promise to preserve transient GUI input across rebuilds. Close the build watcher with the dev server. Do not change the existing headless source loader or require a second dev command.

**Mac adopts the frame.** Replace its direct `app.gui.mount` call, keeping WebSocket transport and attached-agent UI outside the frame. Preserve document-title updates by forwarding bounded title messages through the existing host-message hook to the outer document; [Booter.swift](../platform/mac/native/Sources/shell/Booter.swift) observes that title. Check host keyboard shortcuts and downloads across the new frame boundary. Add only the specific bridge messages needed to preserve existing behavior, not a general DOM or native-API bridge.

**Verify embedded content under the actual policy.** Use a small fixture with a nested sandboxed `srcdoc` document, a blob module, a stateful control, and selected-text messages. Local documents [inherit CSP](https://www.w3.org/TR/CSP3/#security-inherit-csp), so do not infer success or failure from `frame-src` alone. Start with Frieren's existing policy. If the fixture requires an adjustment, establish the exact blocked operation and make the smallest shared change, retaining opaque origins and capability-mediated host access. Generated content receives no kernel client. Do not enable `unsafe-eval`, broad networking, or `allow-same-origin` to make the fixture pass.

## Execution and acceptance

1. Extract the shared frame and migrate Frieren without changing its permissions. Test boot, updates, disposal, reload, and late messages; prove the nested-content fixture in a real browser.
2. Migrate Mac and the dev server. Verify bundled styles/assets/imports, dialogs, titles, shortcuts, downloads, and rebuild recovery. Keep production build/store output compatible and prevent data writes from triggering GUI rebuilds.
3. Run the same fixture in standalone Chromium/WebKit, Frieren, and the actual Mac WKWebView. Confirm controls and selection work, material code cannot reach the parent DOM, and closing/reopening restores persisted state. Browser WebKit is useful coverage but does not replace the native smoke check.
4. Run repository-required checks and relevant host smoke checks. Document rebuild behavior and remaining headless/native differences in the SDK/scaffold guidance. Verify both standalone templates outside the monorepo, then release through the normal SDK process.

Done when all three hosts use the shared GUI frame, a standalone repo can reproduce its permissions and module-loading behavior, and existing app interactions survive migration. This is a moderate platform change; compatibility verification is the main work. Routine app development should then be self-contained, with occasional native smoke checks around releases.

## Implementation and verification

Implemented on `codex/gui-runtime-parity`, incorporating PR #645's storage changes. The shared
frame, all three adapters, production GUI watcher, rebuild recovery, and SDK/scaffold guidance
are in place. Frieren's sandbox flags and CSP are unchanged.

The [fixture and smoke-check notes](../packages/app/test-frame/README.md) cover standalone
Chromium/WebKit, Frieren's browser-kernel window, and the native Mac Booter/WKWebView. Controls,
selection, parent isolation, styles/assets, dialogs, titles, downloads, native shortcuts, and
close/reopen state were exercised. Both standalone templates also passed checks outside the
monorepo with the packed SDK; React rebuild recovery and pinned imports were verified in both
browsers. Repository formatting, linting, all 17 typecheck tasks, and 2,273 tests passed.

PR #645 is merged. Remaining: merge this implementation, then publish through the normal
release-please and `app-v*` tag workflow. No SDK version or release tag has been created by this
implementation.

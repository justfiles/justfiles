_apps/quay · plan_

# Native AppKit launcher + reusable React transcript

Move the launcher **chrome** (panel, fuzzy-search results, composer) from a `WKWebView` to
native **AppKit**, and keep the **agent transcript** as a React view embedded in a transparent
`WKWebView` — reused from frieren, not reimplemented. This kills the web-view resize flash on the
constantly-summoned surface while preserving one (and only one) React chat implementation.

See `DESIGN.md` (§2 process model, §4 shells, §8 agent) for the surrounding architecture.

## Why

- **The flash is structural.** Today every content change measures height in the web layer and asks
  native to `setFrame` (`launcher-ui/launcher.js` `sizePanel`), a two-process round-trip that flickers
  on every keystroke. Native composes layout + window resize synchronously in one process — Spotlight /
  Raycast / Alfred are native for exactly this reason.
- **Don't fork the chat.** The launcher today hand-rolls a minimal chat, diverging from frieren's
  `MessagesPanel`. The transcript is where complexity grows (streaming, tool-call cards), so it should be
  the **one** shared React surface; the chrome is trivial native UI.
- **One JS framework, not many.** AppKit is not a JS framework, so "native chrome + React transcript"
  leaves exactly one JS framework in play (React, reused), honouring the no-multiple-frameworks rule.

## Headline decisions

**Shared package?** Put it in the existing `@justfiles/ui` — no new package. That package's only current
export, `FileTreeView`, is being replaced by an open-source one, so `ui` is the natural home. Add a
**presentation-only** `Transcript` (the view + the message types) to it. The session / client / transport
stays per-host (frieren keeps its `AgentClient`; quay builds its own over a Cap'n Web `SocketLike`). Keep
the surface tiny.

**dist build vs. import `.tsx`?** Import `.tsx`, **build in the consumer — no dist.** This is the repo
convention (`@justfiles/ui` exports `./src/*.tsx`, only a `typecheck` script) and both consumers already
compile TSX: frieren via vite, quay via quayd's esbuild (`quayd/assets.ts`, which already bundles every
mini-app `gui.tsx`). A dist build would add a watch/rebuild step, stale-artifact risk, and a publish
dance for a private package — pure overhead, against CLAUDE.md ("node runs TS directly; minimum deps").
The only reason to pre-build to dist is a consumer that *can't* compile TSX; there isn't one.

**Where is the chat built, then?** Serve it from **quayd over http**, like a mini-app GUI — not from the
local `launcher-ui` bundle. Critically it is **pre-built at quay build time and served as static bytes**,
never compiled on the user's machine (see next section): it is our shipped code that never changes at
runtime. So `build.sh` itself stays Swift-only, but packaging gains a small ship-time asset build (shared
with the vendor bundle). This also matches runtime reality: the chat is useless without quayd, while the
native chrome (search/launch) keeps working standalone.

## Build cost: build at ship/install time, never at load

**Principle: build when code is authored / installed / shipped — never at load.** The ~0.5s some assets
cost is esbuild *compile* time; today part of it runs inside quayd on the user's machine, and the launcher
transcript must not add to it.

- **App `gui.js`** — already correct. devkit builds it at **install time** (`installDraft` esbuilds
  `gui.tsx` → bytes in the Volume's `/applications/<id>`); quayd serves static bytes. Not built at load.
- **Launcher transcript** (new) — **pre-build at quay build time**, ship as static bytes under quayd's
  resources, serve them straight through. It is our shipped code and never changes at runtime, so there is
  no reason to compile it on the user's machine. Its bare `react` import externalises to `/vendor/*`.
- **React vendor family** (`assets.ts`) — *currently* built lazily on first app open and disk-cached by
  `react@<version>|rev=<REV>`. That cache makes it once-per-machine, **but the first build sits on the
  critical path of the first app launch** (the webview's `modulepreload` of `/vendor/*` blocks on esbuild).
  It's fixed at ship time too, so it **should also move to ship-time pre-build**. This is a change to the
  existing pipeline, separable from the launcher work, but the launcher transcript should follow the
  ship-time model from the start rather than re-adopting the runtime-cache one.

What ship-time building does **not** remove: the per-launch fetch+parse+execute of the JS in each cold
WebContent process — the dominant first-paint cost, addressed by minify + prod React (`assets.ts`),
reducible only by shrinking the bundle. The one legitimate runtime build that stays is devkit's live
preview (`devkit.run`, deferred) — a dev loop where build-on-change is correct.

**Costs of moving to ship-time (small, accepted):** quayd currently runs from source with no build step,
so packaging gains a small `esbuild` step emitting the vendor + transcript bundles into quayd's resources;
and the runtime cache's self-healing on `pnpm update react` is lost, so that asset build must be wired into
`pnpm build`/turbo (not a developer's memory) to avoid shipping stale React.

## Target seam

```
Quay.app  (Swift / AppKit)
└─ NSPanel + NSVisualEffectView           ← vibrancy (kept)
   ├─ NSStackView/NSTableView  results     ← native, fed by a Swift ws client
   ├─ WKWebView (transparent)  transcript  ← React <Transcript/>, served by quayd
   └─ NSTextField/NSTextView   composer    ← native, the ONLY input

native ↔ web bridges:
  native → web : evaluateJavaScript  →  window.quaySend(text) / quayAbort()
  web → native : webkit.messageHandlers.status  →  { isStreaming, connectionState }
  catalog/launch: Swift URLSessionWebSocketTask → quayd  (port/token from runtime.json)
  agent stream : the chat webview's own Cap'n Web berth → quayd  (DESIGN §8, privileged)
```

Native owns the panel frame per mode (apps vs. chat), so the per-keystroke resize flash is gone; only
the infrequent mode-switch resizes, which native can animate.

---

## Phase 1 — extract the shared `Transcript` (pure web, no native risk)

Independently shippable; frieren behaviour unchanged. Valuable on its own (de-dupes the chat view).

1. **Extend `@justfiles/ui`** — no new package. Add a `Transcript` export alongside (soon replacing)
   `FileTreeView`; the package already ships raw `.tsx` via `exports`, has the `react` peer dep, and runs
   only `typecheck`. Add `"./Transcript": "./src/Transcript.tsx"` to its `exports`.
   - Move `apps/frieren/src/agent/types.ts` (`AgentMessage`, `ToolCallInfo`) into `ui` — the shared shape.
   - Extract from `MessagesPanel.tsx`: the history list (`:58-66`) + `MessageItem` / `Bubble` /
     `SystemRow` / `ToolCallRow` into `Transcript`, plus the auto-scroll effect (`:19-23`).
   - **Props-driven, not hook-driven:** `Transcript({ messages, isStreaming, userName })`. No context,
     no `useAgentSession`, no client — transport-agnostic, minimal interface.
   - **Restyle off Tailwind to design tokens.** frieren's `MessagesPanel` is Tailwind-classed, but
     Tailwind is being sunset (build-time CSS can't serve dynamically-installed apps). Since `Transcript`
     is becoming shared and quay can't use Tailwind, author it with plain markup + `@justfiles/design`
     tokens / `mac.css` defaults (the existing inline `var(--…)` styles in `MessagesPanel` already point
     the way). This makes `Transcript` the first token-styled shared component; frieren renders it fine
     (it loads `design.css`).
2. **Refactor frieren `MessagesPanel`** to compose `header + <Transcript/> + input form`, feeding it from
   the existing `useAgentSession`. The web app keeps its web input and header untouched.
3. **Verify:** `pnpm typecheck && pnpm test`; `cd apps/frieren && pnpm run dev` + `pnpm run verify:ui`
   smoke — chat renders and sends as before.

## Phase 2 — quayd serves the launcher chat surface

1. **quay chat entry** — a tiny React entry that builds a session over the **Cap'n Web/ws** connection
   (reuse the `AgentClient`/snapshot pattern; the launcher connection is the privileged one, DESIGN §8),
   renders `<Transcript .../>` from `@justfiles/ui`, exposes `window.quaySend(text)` /
   `window.quayAbort()`, and posts `{ isStreaming, connectionState }` to native via
   `webkit.messageHandlers.status`.
2. **quayd route** (`server.ts` + `assets.ts`): `GET /launcher/chat` returns the HTML shell (importmap +
   `@justfiles/design` css, same shape as the mini-app shell) and serves the **pre-built** chat bundle as
   static bytes (emitted by the ship-time asset build, alongside the vendor bundle); bare `react`
   externalises to `/vendor/*`. Update the `assets.ts` comment ("launcher never needs React" is no longer
   true).
3. **Verify:** open `http://127.0.0.1:PORT/launcher/chat?token=…` in Safari → transcript renders, streams;
   `quaySend()` from the console drives a turn.

## Phase 3 — native AppKit launcher

Replace the single launcher `WKWebView` with AppKit views (the booter is unaffected).

1. **Chrome:** keep `NSPanel` + `NSVisualEffectView`; add a native **composer** (`NSTextView` for
   auto-grow parity with the current `field-sizing` textarea) and a **results list** (`NSStackView` of
   icon+label rows — ≤7 visible, simpler than `NSTableView`). Port selection/hover/keyboard nav (↑/↓,
   Enter, Esc, ⌘K) from `launcher.js` into Swift.
2. **Catalog over Swift ws:** a `URLSessionWebSocketTask` speaking the existing JSON protocol
   (`{type:'list'}` → `{type:'catalog'}`), using port/token from the runtime.json discovery the launcher
   already does. Launch stays `NSWorkspace.open`.
3. **Embed the transcript webview:** a transparent `WKWebView` (`drawsBackground=false`, page paints no
   background — the trick the current launcher already relies on, `index.html:16-20`) pointed at quayd's
   `/launcher/chat`. Keep it **warm** (loaded hidden at startup) so entering chat is a reveal, not a cold
   load.
4. **Bridges:** `WKScriptMessageHandler` for `status`; `evaluateJavaScript` for `quaySend`/`quayAbort`.
   Enter in the native composer → `quaySend`; native renders Stop when `isStreaming`.
5. **Mode + sizing:** native switches between results and the chat webview and sets panel height per mode
   synchronously — no web→native resize calls anywhere.

## Phase 4 — cleanup & verify

1. **Delete `launcher-ui/index.html` + `launcher.js`** (chrome is native; chat is served by quayd). The
   `launcher-ui/` folder either disappears or holds only the chat entry source.
2. **Verify end-to-end:** summon → type → native results filter with no flash → Enter launches; ⌘K → chat
   reveals, type in native composer → React transcript streams; Stop aborts; quayd-down → chrome still
   works, chat shows Connecting.

---

## Styling: where each rule lives (during the restyle)

`@justfiles/design` already has three layers — `:root` **tokens** (values), `ds-*` **component classes**
(`ds-menu`, `ds-window`, `ds-dock`…), and `mac.css` **bare-element defaults**. As you de-Tailwind each rule
in `Transcript`, classify it rather than dumping everything local:

- **Is it a token?** Any reused *value* — colour, spacing, radius, font, a status hue. Put it in
  `design.css` `:root` (and the dark-mode block). **Colours especially must be tokens:** dark mode flips
  only by re-pointing tokens, so a raw `rgba(…)` in the component silently breaks dark mode (design.css:
  "apps that only consume tokens get dark mode for free").
- **Is it a generalizable component?** A reusable widget beyond chat (e.g. a disclosure/“details” row, a
  status dot). Promote it to a `ds-*` class. Changing the scope of `packages/design/` to host a bigger
  system is in-bounds — if the pattern recurs, it belongs there.
- **Is it `Transcript`-specific and hard to generalize?** Bubble geometry (max-width, left/right
  alignment, `white-space: pre-wrap`), the streaming caret animation, message-list spacing — keep these
  **local** to the component. Don't tokenize one-off layout.

Concrete calls from today's `MessagesPanel`: user-bubble `var(--focus)` / `var(--on-focus)` → already
tokens, reuse. Assistant-bubble `rgba(255,255,255,0.62)` → a recurring translucent surface → **new token**
(e.g. `--surface-subtle`). `font-mono` (used here *and* in `FileTreeView`) → **new `--font-mono` token**.
Tool-call status hues (`#f59e0b` running, `#dc2626` error) → **status tokens** if they recur, else local.
Bubble radius / max-width / the caret → **local**. When unsure, default to local and promote on the second
use.

## How `build.sh` changes

`build.sh` (the Swift shell builder) stays Swift-only; the JS build is a separate **ship-time asset step**,
not a runtime one:

- **`swiftc` line:** same command, more sources (`Composer.swift`, `Results.swift`, …).
- **Drop `cp -R ../launcher-ui` (`build.sh:69`)** — there is no local web bundle for the launcher anymore;
  the transcript is served by quayd from its pre-built resources.
- **New ship-time asset build** (a `pnpm`/**esbuild** script, wired into `pnpm build`/turbo — *not*
  `build.sh`): emits the vendor React bundle + the transcript bundle into quayd's shipped resources. This
  is the step that replaces today's first-open runtime build, and it must re-run on a React bump (it owns
  the version). **esbuild, not vite** — it reuses `assets.ts`'s existing `bundle()` (externalised-React
  ESM, the same shape as a `gui.js`); vite's dev-server/HMR/HTML+CSS pipeline is irrelevant here, and the
  Tailwind sunset removes the only CSS-build reason to want it.
- **No CSS build.** Styling is runtime CSS — `@justfiles/design/mac.css` (tokens + `:where()` defaults),
  already served by quayd (`designAsset` → `/design/mac.css`) and `<link>`ed by the chat shell. Nothing to
  compile; Tailwind is gone.

So "we need to build now" is true — but it's one ship-time pass over fixed code, and quayd serves the
output as static bytes. No compile on the user's machine, no compile per load.

> **Why serve from quayd (http) rather than `loadFileURL` from the `.app`?** Both are pre-built, so it's
> not about build cost. Serving from quayd reuses one delivery path: the shared `/vendor/*` React singleton
> (importmap) and the `@justfiles/design` shell the mini-apps already use — so the transcript shares React
> with everything else instead of bundling its own copy into the `.app`. And the chat needs the daemon
> anyway, so there's nothing to gain from making it loadable without it.

## Why "import `.tsx`, build in consumer" works (mechanics)

pnpm workspace-symlinks `@justfiles/ui` into `node_modules` pointing at its source; each consumer's
bundler follows the symlink and compiles the `.tsx` inline:

- **frieren / vite** transpiles JSX and tree-shakes during its normal app build.
- **quay / quayd esbuild** (`assets.ts`) resolves the import to the package source, compiles JSX via the
  automatic runtime, and **externalises `react`** to the importmap `/vendor/*` — so React is vendored once
  and the transcript bundle stays tiny. No separate artifact, nothing to keep in sync.

## Risks / decisions to lock before coding

- **Native auto-grow composer** (`NSTextView` height tracking) is the fiddliest native piece — it replaces
  the CSS `field-sizing` trick. Budget for it.
- **Header:** drop frieren's chat header (avatar/online) in the launcher, or render it natively. Keep
  `Transcript` header-free; each host adds its own chrome.
- **Design tokens, not Tailwind:** `Transcript` must be authored on `@justfiles/design` tokens / `mac.css`
  (Tailwind is being sunset). The chat shell `<link>`s `/design/mac.css` or the bubbles render unstyled.
  Restyling the extracted component is part of Phase 1, not a follow-up.
- **Interactivity creep:** today's transcript is read-mostly, so the native composer can own the keyboard
  cleanly. If tool-call cards become interactive (clicks/focus), the native↔web focus seam gets harder —
  keep the transcript display-oriented as long as possible.

## Reuse vs. new

**Reused:** `@justfiles/design` (tokens), quayd's esbuild + React-importmap pipeline (`assets.ts`), the
Cap'n Web berth/`SocketLike` (DESIGN §8), frieren's `AgentClient`/session pattern, the runtime.json
discovery the launcher already performs.

**New:** a presentation-only `Transcript` + message types **added to `@justfiles/ui`** (no new package),
the quay chat React entry + `/launcher/chat` quayd route, the native AppKit chrome (composer + results +
bridges + Swift ws client). **Removed:** `launcher-ui/{index.html,launcher.js}`, and `@justfiles/ui`'s
`FileTreeView` (superseded by an open-source package).

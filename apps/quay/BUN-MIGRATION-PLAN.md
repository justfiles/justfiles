_apps/quay · plan_

# Bun runtime migration (with a node escape hatch)

Move quay's daemon (`quayd`) and the devkit's bundler off **Node + tsx + native esbuild**
onto **Bun**, so that:

- the shipped `Quay.app` is **self-contained** — one `bun build --compile` executable that
  embeds the runtime, the daemon, and the bundler (no system node, no `tsx`, no repo at
  runtime, no native esbuild binary to carry);
- the devkit compiles installed apps **in-process** with `Bun.build` (the bundler is part of
  the embedded runtime), and gains CSS handling for free;
- **we can abort the migration at any time** — even after it has shipped — and fall back to
  Node by flipping a single build switch, with **no source deletion**.

This supersedes the Vite-pipeline exploration. See `DESIGN.md` (§2 process model, §9 devkit)
and the prior packaging findings for context. Background on why this beats the Vite route:
Bun's bundler is esbuild-compatible, ~1.75× faster than esbuild, supports fully in-memory
virtual builds (the devkit's whole model), and is *embedded in the runtime* — so it removes
shipping complexity instead of adding a toolchain tree.

## Goal / non-goals

**Goal.** Bun is the production runtime for `quayd`; `Bun.build` is the server-side bundler for
devkit compile, ship-time assets, and the production daemon bundle.

**Non-goals.**
- **Typecheck is untouched.** `Engine.typecheck` stays on the TypeScript compiler API (Bun
  strips types, it does not check them). The tsc RAM cost is a separate problem this migration
  does not solve.
- **The browser offline fallback stays on esbuild-wasm.** Bun cannot run in a browser, so
  frieren's offline compile keeps its own engine. "Drop esbuild" means *drop it from the
  server*, not everywhere.
- **No behavior change to apps.** Same `gui.js`/`app.js` artifacts, same React singleton, same
  kernel semantics.

## Reversibility contract (the load-bearing constraint)

Every place where Node and Bun genuinely diverge gets **two files behind one stable specifier**,
selected automatically by which runtime is running — never by editing or deleting code:

```
#<name>  ──▶  <name>.node.ts   (node condition)
         └─▶  <name>.bun.ts    (bun  condition)
              <name>.shared.ts  (pure logic both import — minimize duplication)
```

Selection uses **package.json `imports` + runtime conditions** (a standard Node feature Bun
also honors):

```jsonc
// package.json
"imports": {
  "#raw":    { "bun": "./quayd/raw.bun.ts",    "node": "./quayd/raw.node.ts" },
  "#engine": { "bun": "@justfiles/app/engine/bun", "node": "@justfiles/app/engine/esbuild" }
}
```

- Running under **node** → node resolves the `node` key → the `.node.ts` side; the `.bun.ts`
  side is never imported, so never parsed or bundled.
- Running under **bun** → bun prefers the `bun` key → the `.bun.ts` side.
- Bundling: `Bun.build`/esbuild honor the same conditions (`--conditions`), so the unused side
  is excluded from the artifact.

**To abort, after shipping or before:** build/run with Node. No file is removed; the Bun files
simply stop resolving. The _only_ switch is the runtime you launch + the conditions you bundle
with — both driven by one `build.sh --runtime node|bun` flag (below). CI keeps **both** paths
green until/unless we ever decide to delete one.

Keep the split surface **minimal**: create a `.node`/`.bun` pair only where behavior actually
differs (verified by Spike A/B). Everything else — kernel, capabilities, host, server, agent,
materialize — is runtime-agnostic Node-API code that must run unchanged on both.

---

## Spikes — do these first, they gate everything

### Spike A — `quayd` runs on Bun

Boot the daemon under Bun and exercise the gnarly Node-API surface it actually uses. Pass/fail
gate for the whole migration; if Bun can't host the daemon, nothing else matters.

Run: `bun quayd/main.ts` (Bun runs TS + ESM + top-level await natively — no `--import tsx`).

Check, in order of risk. For each, the column on the right is the **Bun-native reimplementation**
to fall back to *if* Bun's Node-compat shim misbehaves — written into the `.bun.ts` sibling
behind the same `#specifier`, leaving the Node original untouched:

| # | Node-compat surface (today) | Probe | Bun-native fallback if it breaks |
|---|---|---|---|
| 1 | **worker_threads sandbox** (`quayd/nodeSandbox.ts`) — `new Worker(...)`, `postMessage`, idle eviction | install an app, dispatch into its reducer worker, confirm eviction | **Web `Worker`** (`new Worker(new URL('./worker.ts', import.meta.url))`) — Bun's first-class worker API, runs `.ts` directly and embeds in `--compile`. → `#sandbox` split |
| 2 | **Cap'n Web berth over `ws`** (`quayd/server.ts`, `capnweb`) | a `dispatch`/`state`/`subscribe` round-trip | **`Bun.serve({ websocket })`** server + native `WebSocket` client; feed capnweb a Bun socket-like adapter. → `#server` split |
| 3 | **`node:crypto`** (`randomBytes` for the token) | token generated, berth auth works | **Web Crypto** `crypto.getRandomValues` / `crypto.randomUUID` (no split needed — both are global) |
| 4 | **`child_process` booter spawn** (`materialize.ts`) | materialize an app, launch its `.app` | **`Bun.spawn`** — same shape, Bun-native process control |
| 5 | **`node:http` server** | the asset/app routes serve | **`Bun.serve`** (folds into #2's adapter) |
| 6 | **`node:fs/promises`** (Volume, discovery, materialize) | Volume reads/writes, `runtime.json` | well-supported under Bun; `Bun.file()`/`Bun.write()` only if a gap appears |
| 7 | **`?raw` markdown imports** (`quayd/rawLoader.mjs`, agent docs) | `import x from './x.md?raw'` resolves | **`Bun.plugin` text loader** via `bunfig.toml` `preload`, or `with { type: 'text' }`. → `#raw` split |

**The fallback is not a rewrite — it's the reversibility split doing its job.** When a Node API
doesn't hold under Bun you don't patch it globally and you don't abandon the migration; you
implement the Bun-native version once in the `.bun.ts` file behind its `#specifier`, keep the
`.node.ts` original intact, and lift any shared logic into `.shared.ts`. Node keeps resolving the
Node side, Bun resolves the Bun side. So Spike A's real output is **two lists**: APIs that pass
on Bun's compat layer as-is (stay single-source), and APIs that need a Bun-native sibling (the
split set). Either way the node escape hatch survives unchanged.

**Pass criteria:** daemon boots, an app installs + dispatches, the agent answers one prompt, a
sandbox evicts — on Bun, with each broken surface either compat-clean or reimplemented in its
`.bun.ts` sibling. A surface that *cannot* be expressed in Bun-native API at all (don't expect
one here) is the only thing that would actually block the migration.

Docs: [Bun Node.js API compatibility](https://bun.com/docs/runtime/nodejs-apis) ·
[Workers](https://bun.com/docs/api/workers) ·
[`Bun.serve` WebSockets](https://bun.com/docs/api/websockets) ·
[`Bun.spawn`](https://bun.com/docs/api/spawn) ·
[File I/O (`Bun.file`/`Bun.write`)](https://bun.com/docs/api/file-io) ·
[bunfig preload](https://bun.com/docs/runtime/bunfig) ·
[Bun runtime plugins (`Bun.plugin`, text loaders)](https://bun.com/docs/runtime/plugins)

### Spike B — `Bun.build` does an in-memory devkit compile

Port the devkit's esbuild `vfs` plugin (`packages/app/engine.esbuild.ts`) to a `Bun.build`
plugin and compile one app's `app.ts` + `gui.tsx` **entirely from an in-memory `files` map**
(no disk), with React externalized and the system `runtime` injected as virtual modules.

Validate the capabilities the devkit depends on:
1. **Virtual entrypoint + virtual modules** — `onResolve`/`onLoad` intercept the entry and all
   `files`-map / runtime modules. (This was the blocker; fixed in Bun 1.2.22 — entrypoints now
   run through plugins, enabling virtual entry points.)
2. **External bare specifiers** — `react`, `react-dom/client`, `react/jsx-runtime`… stay bare
   in the output (resolved by the shell importmap at load), same as esbuild's `external`.
3. **In-memory output** — read bytes back from `result.outputs[n].text()`/`.arrayBuffer()`, no
   temp dir.
4. **CSS (bonus)** — a `gui.tsx` that imports `./x.css` bundles correctly (the FE feature the
   esbuild path lacks). Try `bun-plugin-tailwind`.
5. **Inside a standalone** — confirm `Bun.build` is callable from within a `bun build --compile`
   binary (so install-time compile works in the shipped `.app` with no external toolchain).

**Pass criteria:** a `gui.js` + `app.js` that mount in a window with the React singleton intact;
diff against the esbuild output for shape parity.

Docs: [Bun bundler (`Bun.build`)](https://bun.com/docs/bundler) ·
[Bundler plugins (`onResolve`/`onLoad`)](https://bun.com/docs/bundler/plugins) ·
[Migrating from esbuild](https://bun.com/docs/bundler/esbuild) ·
[Bun 1.2.22 — virtual entrypoint fix](https://bun.com/blog/bun-v1.2.22) ·
[Single-file executables (`--compile`)](https://bun.com/docs/bundler/executables)

---

The three sections below are the **areas of change** in this one migration — not alternative
directions to pick between. They are ordered (and interleaved with the scaffolding step) in
**Sequencing**, below; note the devkit backend lands before the runtime flip.

## Workstream 1 — Bun as the `quayd` runtime

### Dev (`pnpm`)

- Add a `quayd:bun` script: `bun quayd/main.ts` — no `--import tsx`, no `rawLoader.mjs` (if
  Spike A shows `?raw` needs help, register it via `bunfig.toml` `preload` instead). Keep the
  existing node `quayd` script untouched: that *is* the escape hatch.
- Add `bun-types` (a.k.a. `@types/bun`) as a devDependency so `Bun.*` typechecks; the daemon's
  `tsconfig` gains it. Node-side files don't reference `Bun.*`, so they still typecheck clean.

### Native spawn (make the runtime a stamped value, not Swift logic)

Today `Launcher.swift` `Quayd.spawn()` hardcodes `--import tsx`. Refactor it to be
**runtime-agnostic**: read generic plist keys and exec them verbatim.

- `build.sh` gains `--runtime node|bun` (default chosen per release). It stamps:
  - `node`: `QuaydRuntime=<node>`, `QuaydArgs=["--import","<rawLoader>","--import","tsx"]`,
    `QuaydScript=<…>/main.ts`
  - `bun`: `QuaydRuntime=<bun>`, `QuaydArgs=[]`, `QuaydScript=<…>/main.ts`
  - shipped: `QuaydRuntime` points at the embedded binary inside the bundle (Plan 3), paths
    bundle-relative, not the dev machine's.
- `Quayd.spawn()` becomes: run `QuaydRuntime` + `QuaydArgs` + `QuaydScript`. The node-vs-bun
  decision now lives entirely in the plist, so flipping `--runtime` and rebuilding the shell
  switches runtimes with zero Swift or daemon edits — the reversibility hinge.

### Diverging files (create only if Spike A demands)

- `#raw` → `raw.node.ts` (the current ESM loader) / `raw.bun.ts` (`Bun.plugin` onLoad → text,
  via `bunfig` preload). Only if `?raw` doesn't work natively under Bun.
- `#sandbox` → `sandbox.node.ts` / `sandbox.bun.ts` sharing `sandbox.shared.ts` — **only if**
  worker bootstrap diverges; otherwise `nodeSandbox.ts` stays single-source and runs on both.

## Workstream 2 — devkit Bun backend

The devkit already injects the bundler (`engine.esbuild.ts` takes the build seam), so this is a
parallel implementation behind the `#engine` condition — not a rewrite of the engine contract.

In `packages/app`:
- **`engine.vfs.ts` (new, shared, pure).** Extract the bundler-agnostic logic out of
  `engine.esbuild.ts`: the `files`-map resolve/load, `loaderFor(ext)`, the `EXTERNAL` React
  list, runtime-map (`buildRuntime`) injection, and result shaping. No esbuild/Bun types here.
- **`engine.esbuild.ts` (keep).** Now a thin esbuild adapter: an esbuild plugin whose
  `onResolve`/`onLoad` call into `engine.vfs.ts`, plus the `esbuild.build` options. This is the
  node side and the basis the browser esbuild-wasm path keeps sharing.
- **`engine.bun.ts` (new).** The same, expressed as a `Bun.build` plugin + `Bun.build` options.
  References `Bun.*` (covered by `bun-types`); never imported under the node condition.
- **Exports.** Add `./engine/esbuild` and `./engine/bun` to `@justfiles/app` `exports`.
- **`buildRuntime`.** Parametrize over the injected build fn (preferred — keeps it single
  source) or split `devkit-runtime.{node,bun}.ts` if the bundler calls diverge too much.
- **`Engine.typecheck`** — unchanged, shared, runs on both runtimes.

In `apps/quay`:
- `quayd/devkit.ts` selects the engine via `import … from '#engine'` (resolves esbuild under
  node, bun under bun). The injection point that today imports `build` from `esbuild` moves
  behind this condition.

Net: the divergence is the thin per-bundler plugin glue (~tens of lines each); everything
substantive lives once in `engine.vfs.ts`.

## Workstream 3 — production build with Bun

- **`bun build --compile`** produces one self-contained executable embedding Bun + the bundled
  daemon. Cross-compile per arch with `--target=bun-darwin-arm64` / `-x64`. This single artifact
  replaces the embedded-node + tsx + bundled-daemon + shipped-esbuild-binary stack — and because
  `Bun.build` is in the runtime, install-time devkit compile works in-process with nothing
  external (pending Spike B #5).
- **Ship-time assets** (`quayd/build-assets.ts`) → port the vendor/boot/chat bundles from
  `esbuild` to `Bun.build`, so the server side has **zero** esbuild dependency. Keep the
  externalized-React shim shape identical.
- **Hermetic devkit inputs stay baked at ship time** — the `buildRuntime` system-lib map + a
  `.d.ts` TypesBundle for tsc. Bun resolves deps like Node, so the no-`node_modules` problem is
  unchanged by this migration; the bake is still required.
- **Embed the daemon in the launcher only.** `Quay.app` carries the executable; booter `.app`s
  discover-or-launch it via `runtime.json`, so the runtime ships once.

### Reversible production path

Keep a **node production target** alongside the bun one, both driven by `build.sh --runtime`:
- `build:bun` → `bun build --compile` single exe.
- `build:node` → esbuild-bundle `quayd` to one ESM file + embedded node binary + esbuild binary
  (the path from the earlier packaging report).

Two coexisting targets means "abort after shipping" is a re-run of `build:node`, not a revert.

---

## Sequencing

1. **Spike A + B** (throwaway branches). Gate. Record the real divergence set.
2. **Reversibility scaffolding** — add the `#imports` map, `bun-types`, the `build.sh --runtime`
   flag, and the runtime-agnostic `Quayd.spawn()`. Node path still default and green.
3. **Workstream 2 (devkit backend)** — `engine.vfs.ts` extraction + `engine.bun.ts`; both
   engines tested. Lowest-risk, self-contained, valuable even if the runtime switch slips.
4. **Workstream 1 (runtime)** — flip dev to `quayd:bun`; address the Spike-A shim list.
5. **Workstream 3 (packaging)** — `bun build --compile`, port assets, embed in the launcher.
6. **Default `--runtime bun`** for release once both CI paths have been green for a soak period.

## CI / verification

- **Matrix typecheck + test under node *and* bun** for shared code; engine tests run against
  both `engine.esbuild` and `engine.bun`. This is what keeps the escape hatch real rather than
  theoretical.
- Per CLAUDE.md: `pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test` must pass under
  both runtimes before `--runtime bun` becomes the default.
- End-to-end smoke on the bun standalone: launch `Quay.app` → app window paints → dispatch
  round-trips → `devkit.install` compiles a new app in-process → it projects to the launcher.

## Risks / open questions

- **Spike A is the real gate.** worker_threads isolation + native-toolchain interplay is exactly
  where Bun-compat needs proof, not assumption. Per Spike A, a broken surface is reimplemented
  Bun-native in its `.bun.ts` sibling, so the only true blocker is a surface with *no* Bun-native
  expression (none expected here). Note Workstream 2 also rides this gate: `Bun.build` only runs
  under Bun, so there is no devkit Bun backend without the runtime switch.
- **`Bun.build` inside `--compile`** (Spike B #5) — if the embedded bundler isn't callable at
  runtime, install-time compile needs a shipped bundler the way the node path ships esbuild;
  size win shrinks but the model still holds.
- **tsc unchanged** — the original RAM pressure is untouched; don't oversell the migration as
  solving it.
- **`bun-types` global pollution** — `Bun.*` typings are global; ensure node-side files don't
  accidentally lean on them (lint guard, or scope the types to the bun tsconfig).
- **Two-bundler drift** — esbuild (node + browser) and `Bun.build` (server) can emit subtly
  different output; the engine tests must diff artifact shape, not just "it builds".

## Useful documents

- Bun bundler `Bun.build`: <https://bun.com/docs/bundler>
- Bundler plugins (`onResolve`/`onLoad`, virtual modules): <https://bun.com/docs/bundler/plugins>
- Migrating from esbuild (API map, supported subset): <https://bun.com/docs/bundler/esbuild>
- Single-file executables (`bun build --compile`, cross-target): <https://bun.com/docs/bundler/executables>
- Runtime plugins / loaders (`Bun.plugin`, `?raw`/text): <https://bun.com/docs/runtime/plugins>
- `bunfig.toml` (`preload`): <https://bun.com/docs/runtime/bunfig>
- Node.js API compatibility (worker_threads, `node:` modules): <https://bun.com/docs/runtime/nodejs-apis>
- Bun 1.2.22 — virtual entrypoint fix: <https://bun.com/blog/bun-v1.2.22>
- Node subpath imports (`#imports`): <https://nodejs.org/api/packages.html#subpath-imports>
- Node conditional exports / user conditions (`--conditions`): <https://nodejs.org/api/packages.html#conditional-exports>
</content>
</invoke>

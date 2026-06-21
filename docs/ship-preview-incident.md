# Incident: app-code preview blank in the bun ship build

**Date:** 2026-06-21 · **Symptom:** launching app-code (Code) in quay, the preview
pane stayed blank and the status badge showed **Idle**.

## TL;DR

Four latent bugs, all triggered only by the **bun `--ship` build** (a `bun build
--compile` standalone exe: no `node_modules`, no esbuild on disk, production-bundled
vendor React). Dev (node + esbuild + node_modules) never hit any of them, and the
node `vitest` suite skips `*.bun.test.ts`, so CI stayed green. Not caused by the
recent devkit refactor — switching to the ship build exposed them.

The errors were swallowed at multiple layers (app-code `runBuild`'s `catch {}`),
which is why the only visible signal was "Idle" + blank.

## The four bugs (in discovery order)

1. **Dir-prefixed entrypoint** — `Bun.build({ entrypoints: ['src/app.ts'] })` derives
   `src` as the build root and tries to OPEN it on the real fs → throws
   `FileNotFound: failed to open root directory: src` before the vfs plugin runs (and
   before `throw:false` can swallow it). The `app` entry has the `src/` prefix; the
   `gui` entry survived only because it's wrapped in a top-level shim.
   **Fix:** `root: process.cwd()` in `Bun.build`. (`toolchain.bun.ts`)

2. **`buildRuntime()` in the exe** — it bundles the SDK libs with node `esbuild` +
   `require.resolve` against `node_modules`, neither of which exist in the compiled
   exe → `Cannot find module '@justfiles/app' from '/$bunfs/…'` → compile throws.
   **Fix:** bake the runtime at ship time → `assets-dist/runtime.json`; load the baked
   copy at runtime, fall back to `buildRuntime()` in dev. (`build-assets.ts`, `devkit.ts`)

3. **typecheck false errors** — the exe has no `node_modules`/`.d.ts`, so every import
   reported `TS2307`/empty-JSX in the Problems panel. Fixed by baking a `TypesBundle`
   (`bakeTypes` → `assets-dist/types.json`) keyed as a `node_modules/<pkg>/…` overlay
   (SDK dist `.d.ts` + React `@types` + transitive deps via a `dependencies` BFS). Also
   surfaced a real bug in the **shared** checker: `directoryExists` ignored the trailing
   slash TS passes for directory imports (`import … from "./"` in @types/react's
   jsx-runtime), collapsing JSX to an empty namespace. (`devkit-runtime.ts`,
   `toolchain.typescript.ts`, `build-assets.ts`, `devkit.ts`)

4. **Blank preview / `jsxDEV is not a function`** — `Bun.build` defaults to dev-mode
   JSX (`jsxDEV` from `react/jsx-dev-runtime`), but the vendored React is a production
   build with no `jsxDEV` export, so every draft component threw on mount.
   **Fix:** `define: { 'process.env.NODE_ENV': '"production"' }` in `Bun.build` → emits
   production `jsx`/`jsxs` (matches esbuild + the production vendor). (`toolchain.bun.ts`)

## Files changed

- `packages/app/toolchain.bun.ts` — `root` + `NODE_ENV` define (bugs 1, 4)
- `packages/app/toolchain.typescript.ts` — `directoryExists` trailing-slash (bug 3)
- `packages/app/devkit-runtime.ts` — `bakeTypes()` (bug 3)
- `apps/quay/quayd/build-assets.ts` — bake `runtime.json` + `types.json` (bugs 2, 3)
- `apps/quay/quayd/devkit.ts` — `loadRuntime()` / `loadTypes()` (bugs 2, 3)
- Tests: `toolchain.bun.test.ts` (dir-prefix + production JSX), `devkit-types.test.ts`
  (bake coverage + negative control)

## How it was diagnosed

`bun test` reproduced bug 1. The remaining three only appear in a `bun build --compile`
exe, so each was reproduced with a throwaway standalone exe run from `/` (no
node_modules). Bug 4 was caught by loading the live preview URL in a headless browser
(`http://127.0.0.1:<port>/app/preview.<slug>?token=…`; port+token from
`~/Library/Application Support/quay/runtime.json`, which the HTTP routes don't gate)
and reading the console.

## Verification

typecheck clean · `pnpm test` 691 pass (+3) · bun tests 9 pass · compiled-exe probes:
compile of a `src/` project → 0 errors; starter typecheck → 0 errors with the bundle, a
real type error still flagged.

## Known limitation

The baked `TypesBundle` covers the SDK (all `@justfiles/app` subpaths), `valibot`, and
React. A project importing some other third-party package would see just that import
flagged in the ship build (dev unaffected) — extend the `TYPE_EXTERNAL` roots if needed.

## Why it was hard to see

Failures are swallowed: devkit capability errors cross the worker boundary, app-code's
`runBuild()` drops them with `catch {}`, leaving only "Idle". quayd logs go to
`~/Library/Application Support/quay/quayd.log` (both stdout+stderr); the webviews are
inspectable (`isInspectable = true`).

---
title: 'Devkit sysroot: import-map redesign'
description: Replace the synthesized node_modules tree the devkit sysroot bakes for tsc with an explicit paths import-map, rolled-up self-contained type declarations, and (later) a content-addressed store.
---

## Why

The devkit sysroot is the frozen "stdlib" a draft app compiles and typechecks against —
baked once at `app-code` build time, shipped inside the app bundle at `devkit/**`, loaded
by hosts through a `read(path)` seam (an installed app exposes only `read`, never a
directory listing). It has two consumers with very different resolution models:

| Consumer | Needs | Today's shape |
| --- | --- | --- |
| esbuild/Bun (`compile`) | specifier → JS source | flat map `runtime/<spec>.js` + `index.runtime[]` |
| tsc/tsgo (`typecheck`) | a resolvable module tree | `types/node_modules/<pkg>/…` + **synthesized `package.json` + `exports`** |

The runtime half proves you do not need a tree — a flat `specifier → source` map is enough.
The `node_modules` shape exists *only* because tsc does real Node module resolution
(reads `@justfiles/app/package.json`, follows `exports["./react"].types` → `dist/react.d.ts`).
Everything hacky lives in service of that:

- reads workspace packages' **built `dist/*.d.ts`** → hard dependency on a prior `tsc` build;
- **synthesizes a `package.json`** from `publishConfig.exports` so tsc's `exports` resolution works;
- **BFS-walks transitive `dependencies`** and resolves pnpm symlinks by hand for the externals;
- `types` and `runtime` are two parallel, unrelated trees with two index lists — nothing ties
  "this `.d.ts` is the header for that `.js`."

## Decisions

- **Resolution = an explicit import-map.** tsc's `compilerOptions.paths` *is* an import map
  (cf. Deno `deno.json` imports, Yarn PnP's single manifest). We control the draft tsconfig,
  so we map every SDK specifier → its entry `.d.ts` and drop `node_modules`/`exports`/synth
  `package.json` entirely. Symmetric with the runtime map.
- **Generate + roll up our `.d.ts` with `tsdown`** (its `rolldown-plugin-dts` engine). The repo
  already builds `@justfiles/fs` / `@justfiles/cli` this way and produces rolled declarations,
  so it is proven on this codebase, adds no new bundler, and mirrors the esbuild runtime build
  (same entry list = `sdkRuntimeSpecs`, an `external` list). `@justfiles/app` is the lone
  package still on raw `tsc` — which is why `bakeTypes` had to fake a `node_modules`.
- **Vendor third-party types as-is** (react, react-dom, and valibot). Rolling up someone else's
  `.d.ts` is where rollups break (global JSX namespace, module augmentation) and we gain nothing.
  Vendored packages keep their real relative layout under `vendor/**` and are wired in by the
  same `paths` map.
- **Schema stays `justfiles.devkit.v1`** — nothing has shipped.

## Target shape

```
devkit/
  index.json                                        # manifest: files[], runtime[], paths{}
  runtime/@justfiles/app/capabilities/volume.js     # self-contained JS (unchanged)
  types/@justfiles/app/capabilities/volume.d.ts      # self-contained .d.ts (rolled up, phase C)
  vendor/react/index.d.ts                           # third-party types, real layout (phase C)
```

`index.json`:

```jsonc
{
  "schema": "justfiles.devkit.v1",
  "hash": "sha256-…",                 // whole-sysroot version / cache key
  "files": ["…"],                     // every type file to read (no directory listing on the host)
  "runtime": ["@justfiles/app/capabilities/volume.js", …],
  "paths": {                          // the import-map injected into the draft tsconfig
    "@justfiles/app/capabilities/volume": ["types/@justfiles/app/capabilities/volume.d.ts"],
    "valibot":                            ["vendor/valibot/dist/index.d.ts"],
    "react":                              ["vendor/react/index.d.ts"],
    "react/jsx-runtime":                  ["vendor/react/jsx-runtime.d.ts"]
  }
}
```

The loader derives the two compiler inputs, both pure dictionary lookups:

- `runtime` map (`spec → js`) — for esbuild/Bun, unchanged.
- `paths` map (`spec → entry .d.ts`) — merged into the draft tsconfig with `baseUrl` at the
  overlay root. No tree walk, no `exports`, no `node_modules`.

## Phases

### Phase A — import-map (paths), drop the synthesized `package.json` ✅ DONE

The foundational, low-risk step. Keep today's collection (workspace `dist` + vendored externals)
**unchanged**; change only the *resolution mechanism*.

- `bakeTypes` stops synthesizing the workspace `package.json`. Instead it emits a `paths` map for
  the workspace specifiers, derived 1:1 from each package's `publishConfig.exports`
  (`specifier → node_modules/<pkg>/<types>.d.ts`). External packages keep their real
  `package.json` and resolve by node resolution as before.
- `DevkitIndex` gains `paths`. `writeSysroot` writes it; `loadTypes` returns `{ files, paths }`.
- `typecheck` injects `baseUrl` (overlay root) + `paths` into the compiler options.
- `apps/quay/quayd/devkit.ts` threads `paths` into `typescriptToolchain`.

Removes the synthesized-`exports` coupling and makes resolution explicit and visible in
`index.json`. Blast radius: `devkit-runtime.ts`, `devkit-sysroot.ts`, `toolchain.typescript.ts`,
`quayd/devkit.ts`, and the sysroot tests. The runtime/compile path is untouched.

**Acceptance:** existing devkit type tests pass (the starter typechecks with no `node_modules`
in the overlay), with the synthesized workspace `package.json` gone and resolution flowing
through `paths`.

### Phase C — roll up our `.d.ts` with `tsdown`; vendor externals ✅ DONE

`buildTypes()` (a `.d.ts` twin of `buildRuntime`) runs `tsdown` programmatically over the
`@justfiles/app` SDK source entries (derived from `sdkRuntimeSpecs`) into a temp dir and reads
the rolled `.d.ts` back — **straight from source, no `@justfiles/app/dist` dependency**.
`bakeTypes` = `buildTypes()` (our rolled headers) + `@justfiles/fs` baked from its rolled dist
+ vendored externals. `paths` point at the rolled entry.

What the spike changed from the original sketch:

- **`@justfiles/fs` is inlined** via `noExternal: ['@justfiles/fs']` + `dts: { eager: true }`.
  tsdown (a *library* bundler) auto-externalizes `dependencies`, so fs needs `noExternal` to be
  force-bundled; and rolldown-plugin-dts's default *lazy* emit can't follow fs's type-only
  barrel re-export (`export { type Volume } from './volume'`), so `eager` emits the full program
  declarations upfront. fs's types land in a shared rolled chunk — it vanishes as a sysroot entry,
  needs no `paths` entry, and (built from source) needs no `@justfiles/fs#build`.
- The external surface of our rollups is then `{react, valibot, @standard-schema/spec}` (all
  vendored). `@justfiles/app`'s baked headers are ~12 rolled files.
- Determinism guards: pin `tsconfig` to `@justfiles/app`'s own (the repo-root tsconfig has
  project `references`, which rolldown-dts rejects) and force `outExtensions` to `.d.ts`/`.js`
  (tsdown otherwise picks `.d.mts` from the CWD `package.json` `type`). Verified two builds
  produce an identical sysroot `hash`.
- `turbo.json`: the `@justfiles/app-code#build` override is **deleted** — with types built from
  source, app-code has no workspace `dist` dependency and uses the generic `build` task.
- Cost: `eager` runs a full tsc program, so a cold `bakeTypes` is ~3.5s (then ~90ms warm in the
  same process). app-code builds it once; tests bake once at module load.

Still vendored via the existing `packageDir`/`collectDts`/BFS walk (third-party types must be
copied from `node_modules`): react/`@types/react(-dom)`, `csstype`, `valibot`,
`@standard-schema/spec`, `type-fest`.

### Phase B — content-addressed store ✅ DONE

- Every sysroot file (types + runtime) is stored once at `devkit/store/<sha256-…>`, keyed by
  content. `index.json`'s `files`/`runtime` change from path *lists* to *maps* (logical path →
  blob id); `paths` is unchanged, and the loaders' two derived maps (`spec → .d.ts`, `spec → js`)
  are byte-for-byte identical to before.
- The whole-sysroot `hash` digests the `(kind, logical path, blob id)` manifest in sorted order;
  blob ids already capture content, so it versions the whole tree. Integrity + dedup fall out,
  and the flat `read('devkit/store/<id>')`-by-key model fits the host seam.
- Blast radius: `writeSysroot` (`devkit-runtime.ts`), the loaders + `DevkitIndex`
  (`devkit-sysroot.ts`), and the sysroot test's in-memory `read`. Consumers
  (`quayd`/`frieren`) are untouched — they only call `loadTypes`/`loadRuntime`.
- Verified: deterministic hash across rebuilds; the parallel `types/` + `runtime/` trees
  collapse to one flat `store/` (262 blobs from 267 logical files — 5 deduped); full build 18/18,
  full suite 708/708.

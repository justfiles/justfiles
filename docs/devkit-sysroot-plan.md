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

- **`@justfiles/fs` is NOT inlined.** Forcing it inline (`noExternal`) makes rolldown reject the
  value import of its type-only `Volume` in `kernel.ts` (`Missing export`). So fs stays external
  and is baked from its own (tsdown-rolled) dist + a `paths` entry — unchanged from Phase A.
- The external surface of our rollups is exactly `{@justfiles/fs, @standard-schema/spec, react}`;
  `core`/internal files collapse into a couple of shared rolled chunks (flat, relative refs that
  resolve under the baked dir). `@justfiles/app`'s baked headers went from a ~50-file loose tree
  to **12 rolled files**.
- Determinism guards: pin `tsconfig` to `@justfiles/app`'s own (the repo-root tsconfig has
  project `references`, which rolldown-dts rejects) and force `outExtensions` to `.d.ts`/`.js`
  (tsdown otherwise picks `.d.mts` from the CWD `package.json` `type`). Verified two builds
  produce an identical sysroot `hash`.
- `turbo.json`: `@justfiles/app-code#build` no longer depends on `@justfiles/app#build` (types
  built from source) — only on `@justfiles/fs#build`.

Still vendored via the existing `packageDir`/`collectDts`/BFS walk (third-party types must be
copied from `node_modules`): react/`@types/react(-dom)`, `csstype`, `valibot`,
`@standard-schema/spec`, `type-fest`.

### Phase B — content-addressed store

- Replace readable paths with `store/<sha256>` blobs; `index.json` maps each file/specifier to a
  hash. Integrity + dedup + the existing whole-sysroot hash fall out naturally; the `read`-by-key
  model fits the host seam.
- Drop-in: only the string *values* in `index.json` change (path → `sha256-…`); the manifest
  shape and the loader's two derived maps stay the same.

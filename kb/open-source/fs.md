# Extracting `@justfiles/fs` into its own repo

Plan for moving `packages/fs` out of this monorepo into `xiaoxinghu/justfiles-fs`,
consuming it back as a git submodule, and moving its release pipeline with it.

Status: **planned, not started.** Nothing in this document has been executed.

## Goal

`@justfiles/fs` becomes an independently installable, testable, buildable and
releasable repo — while remaining a first-class pnpm workspace member here, so
consumers keep `workspace:*` and live source edits keep working.

## Findings

### `packages/fs` is a clean leaf

Its source imports nothing from the workspace — only `idb`, `zod`, `node:*`, and
`fake-indexeddb`/`vitest` in tests. The only `@justfiles/*` mentions are in doc
comments. No code has to move with it.

### Nine packages depend on it

`apps/{cli,frieren,mac,worker}` and `packages/{agent,app,core,tasks}`, all via
`workspace:*`. All of them consume it as **source** (its `exports` map points at
`./index.ts`, not `dist`), including `packages/app`'s devkit, which force-inlines
it (`noExternal: ['@justfiles/fs']` + `dts.eager`). No tsconfig `paths` entry and
no project reference points at it — resolution is purely the node_modules symlink.

### A submodule can stay a workspace member (verified)

Tested with a throwaway fixture on pnpm 11.2.2 + turbo 2.9.18:

- A nested `pnpm-workspace.yaml` inside a parent workspace **does not break the
  parent**. pnpm still enumerated both projects and installed normally.
- `catalog:` in the nested package **resolves against the root catalog** when
  installed from the monorepo. With the two catalogs deliberately skewed (root
  `typescript` 6.0.3, nested 5.9.0) the root won, silently.
- `turbo run --dry` enumerated the nested-workspace package and its tasks.

So fs can carry its own workspace file and catalog for standalone use, and inside
the monorepo the root catalog still governs — one compiler for the repo, as
`CLAUDE.md` requires. **This is what makes the whole plan cheap:** consumers need
no import or dependency changes at all.

### Publishing is OIDC, not a token

The repo has no `NPM_TOKEN` secret. `publish-package.yml` runs with
`id-token: write` and no auth token, i.e. **npm trusted publishing**, which is
bound to `xiaoxinghu/justfiles` and its workflow file. This must be re-pointed at
the new repo before the first release from it — see Phase 4.

## Recommended shape

`packages/fs` becomes a git submodule that is still a pnpm workspace member.
Consumers change nothing.

---

## Phase 1 — Carve out the repo with history

1. Start from an up-to-date `origin/main`.
2. On a fresh clone, `git filter-repo --path packages/fs --path-rename packages/fs/:`
   so the fs files land at the repo root. This preserves the `CHANGELOG.md`
   lineage and `git blame`.
3. Decide on the existing `fs-v*` tags: they survive filter-repo, and can either be
   renamed to `v*` to match a standalone release-please, or dropped so the new repo
   starts clean at `v0.6.0`.
4. `gh repo create xiaoxinghu/justfiles-fs`, push.

Note: the local scratch `../justfiles-fs` directory is an empty non-bare repo with
no commits and no remote. Replace it with the filter-repo output rather than
committing into it.

## Phase 2 — Make the fs repo portable

Monorepo assumptions to replace, all inside the package:

| Assumption | Fix |
| --- | --- |
| `tsconfig.json` extends `@justfiles/tsconfig/base.json` | Inline the base `compilerOptions`; drop the `@justfiles/tsconfig` devDep |
| `"typescript": "catalog:"` | Add `pnpm-workspace.yaml` with `packages: ['.']` and `catalog: typescript: 6.0.3` (root catalog still wins inside the monorepo — verified) |
| No test runner; tests run from the root `vitest.config.ts` | Add a `vitest` devDep, a `vitest.config.ts`, and a `test` script |
| No lint/format config | Add `biome.json` mirroring the root settings (tabs, single quotes, semicolons as-needed, width 100, the `*.test.ts` `noNonNullAssertion` override) plus `lint`/`format` scripts |
| No repo hygiene files | `.gitignore` (node_modules, dist, `*.tsbuildinfo`, `.turbo/`), `.node-version` (24), `.npmrc`, `README.md`, `LICENSE`, its own `pnpm-lock.yaml` |
| `volume.test.js` imports `bun:test` | Runs nowhere today — the root vitest `include` only matches `*.test.ts`. Port to vitest or delete |
| `discussion.md` | Keep with the package, or move into this repo's `docs/` |

`build` (tsdown) and `typecheck` (`tsc --noEmit`) already work standalone with no
turbo involvement.

### Version-skew guard

`typescript` is safe via the catalog mechanism above. `vitest` is not: if fs's
vitest resolves to a different version than the root's *and* the root config also
collects fs's tests, two vitest instances load in one run and fail with opaque
internal-state errors. Either pin them equal, or stop running fs tests from the
root config (see Open decisions).

## Phase 3 — Monorepo side

1. `git rm -r --cached packages/fs` and commit, then
   `git submodule add git@github.com:xiaoxinghu/justfiles-fs.git packages/fs`.
2. Add `submodules: true` to `actions/checkout` in **every** workflow that runs
   `pnpm install`: `ci.yml`, `deploy-frieren-{staging,production}.yml`,
   `deploy-worker-{staging,production}.yml`, `publish-package.yml`. Without it
   `packages/fs` is an empty directory and install fails.
3. Delete the `packages/fs` entry from `release-please-config.json` and
   `.release-please-manifest.json`; delete `.github/workflows/publish-fs.yml`.
4. Decide whether the root `vitest.config.ts` still collects the submodule's tests
   (see Open decisions).
5. Same for `biome.json` — if fs owns its style, add `!packages/fs/**` to
   `files.includes`.
6. `CLAUDE.md`: the worktree rule needs a submodule step. `git worktree add` does
   **not** populate submodules, so every new worktree needs
   `git submodule update --init` alongside the existing `.env` / `.dev.vars` /
   `.agent` seeding. Worth mentioning `git config submodule.recurse true` too.
7. `docs/fs.md`: update `Source: packages/fs` and the `pnpm --filter` instructions.
8. Regenerate `pnpm-lock.yaml`. The importer path is unchanged so the diff should
   be near-zero — but any later submodule pointer bump that changes fs's
   dependencies requires re-running `pnpm install` and committing the lockfile, or
   root CI's `--frozen-lockfile` fails.

## Phase 4 — CI/CD in the fs repo

1. **`ci.yml`** — checkout, pnpm, node from `.node-version`,
   `install --frozen-lockfile`, then `typecheck` / `lint` / `test` / `build`.
   Unlike this repo's main-only CI, run it **on pull requests** as well: the
   monorepo can no longer catch fs regressions before merge.
2. **`release-please.yml`** — single-package mode (`release-type: node`), no config
   or manifest file needed. Produces `v0.6.1`-style tags. Needs a
   `RELEASE_PLEASE_TOKEN` secret (a PAT, as here — `GITHUB_TOKEN` will not trigger
   the publish workflow on tag push).
3. **`publish.yml`** — port `publish-package.yml`, trigger on `v*` tags, drop the
   `working_directory` plumbing.
4. **Re-point npm trusted publishing.** On npmjs.com, add `xiaoxinghu/justfiles-fs`
   and the new workflow filename as a trusted publisher for `@justfiles/fs` before
   the first release, or publishing fails auth. This is a manual, external step and
   the single most likely thing to bite.

## Phase 5 — Operating model

- **Changes become two-step.** PR in the fs repo → merge → bump the submodule
  pointer here (plus the lockfile if dependencies changed). Tightly coupled
  fs↔consumer changes now span two PRs.
- **Publish ordering matters.** `@justfiles/app` is public and lists
  `@justfiles/fs` as a real runtime `dependencies` entry with `workspace:*`; pnpm
  rewrites that to the local version at pack time. If the submodule sits at 0.7.0
  while npm only has 0.6.0, a published `@justfiles/app` points at a version that
  does not exist. Order: release fs → bump the pointer → release dependents.
- **Local iteration is unaffected.** The submodule is still a linked workspace
  package, so edits to fs are live in frieren/cli/etc. with no rebuild.

## Open decisions

1. **Who runs fs's tests in the monorepo?** Exclude `packages/fs` from the root
   `vitest.config.ts` and let fs's own CI be the source of truth (no vitest
   instance-skew risk), or keep collecting them here for integration confidence and
   pin the vitest versions equal. *Leaning: exclude.*
2. **Who lints the submodule?** fs owns its `biome.json` and the root excludes it
   (clean ownership, two configs to keep in step), or the root keeps linting it and
   fs's config is standalone-only. *Leaning: fs owns it.*
3. **`volume.test.js`** — port to vitest (it covers the wider `volume.ts` surface
   and currently runs nowhere) or delete?
4. **Tags** — keep the rewritten `fs-v*` history tags, or start clean at `v0.6.0`?
5. **npm auth** — reconfigure trusted publishing for the new repo (preferred), or
   fall back to an `NPM_TOKEN` secret?

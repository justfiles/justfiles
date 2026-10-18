# Design

Implement the smallest solution that fully satisfies the request. Keep core mechanics
and exported APIs small; contain necessary complexity within the relevant module.
Avoid speculative features and abstractions. Introduce an abstraction only when it
makes the current implementation easier to understand or maintain.

# Tools

Use pnpm for package management and `pnpm run` for package.json scripts.
Use node as the JS runtime; it runs TypeScript directly via built-in type stripping.
Use `pnpm dlx` for one-off package commands and vitest as the test runner.

Use tabs for indentation.

# Verification and completion

Documentation-only changes do not require formatting, linting, typechecking, or tests.
For code, configuration, generated artifacts, or executable examples, run checks
appropriate to the affected packages and behavior. Complete mandatory checks.
Broaden verification when shared impact, failures, or unresolved concerns justify it;
repeat passing checks only after relevant changes.

For implementation requests, continue until the requested behavior works and relevant
verification is complete. Fix failures caused by your changes and rerun affected
checks. If blocked, report the specific blocker and what remains unfinished.

# Worktrees

Before editing repository files, inspect the current branch and existing worktrees.
Work on a task branch in its own worktree, and reuse it when it exists. Never edit
directly on `main`.

`ws claim <task>` creates the branch and its worktree, then applies `.ws.yaml`: it
copies the git-ignored local dev files listed under `copy` from the main checkout and
runs `setup`. When a worktree needs another local file, add it to `.ws.yaml`. Without
ws, create the worktree with `git worktree add` and do what `.ws.yaml` says by hand.

# Pull requests

After addressing PR feedback from @codex, end the response comment with `@codex review`.

# Building an app

Consult `docs/app.md` when the task depends on app structure, behavior, or integration
contracts. Apps live in `apps/<name>`; use existing apps as examples.
For a new app, use the `packages/create-app/` template:

```
node packages/create-app/index.js apps/<name>
```

# Adding packages or changing TypeScript configuration

Every package extends a shared base from `packages/tsconfig`, and gets its own
`typecheck` script — turbo runs them all (`pnpm typecheck`), so a new package is
covered automatically. There is no root tsconfig to register it in.

A new package needs three things:
- `"extends": "@justfiles/tsconfig/base.json"` — or `dom.json` (browser/React) or
  `library.json` (ships a `tsc`-emitted `dist/`). Only override what genuinely differs.
- `"typecheck": "tsc --noEmit"` in `scripts`.
- `"typescript": "catalog:"` + `"@justfiles/tsconfig": "workspace:*"` in `devDependencies`.

Never pin a `typescript` version in a package. The whole repo shares ONE compiler via
the pnpm catalog (`pnpm-workspace.yaml`) — a skew means `typecheck` and a package's own
`build` can disagree about the same file.

Note `include`/`exclude` and path-valued options (`outDir`, `rootDir`, `paths`) resolve
relative to the file they are written in, so they must live in the package's own
tsconfig — never in a shared base.

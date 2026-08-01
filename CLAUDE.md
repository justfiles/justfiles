IMPORTANT: keep code minimal
It's very important to keep the core mechanic simple and lean. We can write complex code, as long as it is contained, e.g. complex UI logic. The core of how things work should be as lean as possible.

# Tools
use pnpm for package management.
use node as the JS runtime (node directly runs TypeScript via the built-in
strip-types loader; package.json scripts go through `pnpm run`/`pnpm dlx`).
use vitest as the test runner.

use tab for indentation.

# Testing

Make sure the following tests pass after making file changes:
```sh
pnpm format
pnpm typecheck
pnpm lint:fix
pnpm test
```

## Frieren UI verification

For `apps/frieren` UI changes, do quick LLM-driven smoke checks instead of writing full e2e tests unless asked.

```sh
cd apps/frieren
pnpm run dev
# in another shell:
pnpm run verify:ui
```

`verify:ui` creates/reuses a Clerk dev test user, seeds onboarding, opens an authenticated `playwright-cli` session named `frieren`, and navigates to `http://localhost:5173`. Then take over with arbitrary checks, e.g. `playwright-cli -s=frieren snapshot`, `fill`, `click`, `console`, `requests`. Close with `playwright-cli -s=frieren close`.

## Sandbox reducer frame (Topology B)

When you change the app sandbox worker source (`sandboxWorkerSource` / the reducer frame in `apps/frieren/src/apps/sandbox.worker.ts`), verify the classic reducer Worker still loads + answers the protocol on real browsers -> `pnpm run verify:sandbox` (from `apps/frieren`; needs `npx playwright install`).


# Coding Rules

## Simplicity First.
Minimum code that solves the problem. No speculative features. No abstractions for single-use code. If a senior engineer would call it overcomplicated — simplify.

## Be Very Stingy on interfaces
Keep the module surface to the absolutely minimal. think: do we absolutely have to expose this? Only add to interface when it will break the design otherwise.

## Create a worktree
Once we are ready to make changes to the code, create a branch and a worktree and make changes in there. Unless it's a change to an existing branch, then switch to that worktree. Check whether the branch/worktree exists before creating. Do not change directly on main.

After creating a worktree, seed the git-ignored local dev files — `git worktree`
only checks out tracked files, so these are missing and local runs break without
them. Copy each from the main checkout into the same path in the new worktree:

- apps/frieren/.env
- apps/frieren/.dev.vars
- apps/frieren/.agent
- apps/worker/.env
- apps/worker/.dev.vars
- apps/worker/.agent

## About Pull Requests
After addressed a PR feedback left by @codex, tag codex for re-review at the end of the comment, like so: "@codex review".

# Building an app

The app should follow this path convention: packages/app-<name>. see existing apps as example.
If trying to create a new app, use the packages/create-app/ template.
```
node packages/create-app/index.js packages/app-<name>
```

Before making changes to the app, read docs/app.md to learn how to make an app.
ONLY read the doc when you are asked to create/modify an app.

# TypeScript config

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

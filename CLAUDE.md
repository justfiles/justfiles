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


# Coding Rules

## Simplicity First.
Minimum code that solves the problem. No speculative features. No abstractions for single-use code. If a senior engineer would call it overcomplicated — simplify.

## Be Very Stingy on interfaces
Keep the module surface to the absolutely minimal. think: do we absolutely have to expose this? Only add to interface when it will break the design otherwise.

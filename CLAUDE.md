IMPORTANT: keep code minimal

# Tools
use bun for package management.

use tab for indentation.

# Testing

Make sure the following tests pass after making file changes:
```sh
bun run format
bun run typecheck
bun run lint:fix
bun test
```

## Frieren UI verification

For `apps/frieren` UI changes, do quick LLM-driven smoke checks instead of writing full e2e tests unless asked.

```sh
cd apps/frieren
bun run dev
# in another shell:
bun run verify:ui
```

`verify:ui` creates/reuses a Clerk dev test user, seeds onboarding, opens an authenticated `playwright-cli` session named `frieren`, and navigates to `http://localhost:5173`. Then take over with arbitrary checks, e.g. `playwright-cli -s=frieren snapshot`, `fill`, `click`, `console`, `requests`. Close with `playwright-cli -s=frieren close`.


# Coding Rules

## Simplicity First.
Minimum code that solves the problem. No speculative features. No abstractions for single-use code. If a senior engineer would call it overcomplicated — simplify.

## Be Very Stingy on interfaces
Keep the module surface to the absolutely minimal. think: do we absolutely have to expose this? Only add to interface when it will break the design otherwise.

---
name: testing
description: Test and verify changes in the Justfiles monorepo. Use after any file change, when a user asks to run tests or verify work, after a Frieren UI change, or after a change to the browser sandbox worker or reducer frame.
---

# Test changes

During development, run a focused test when it gives faster feedback:

```sh
pnpm run test packages/fs/watch.test.ts
```

Before completion, run all required checks from the repository root:

```sh
pnpm run format
pnpm run typecheck
pnpm run lint:fix
pnpm run test
```

Review changes from `format` and `lint:fix`. Fix each failure, then run the failed command again.

## Check the Frieren UI

For a visible change in `apps/frieren`, use a short Playwright CLI smoke check. Do not add a full end-to-end test unless the user asks for one.

Start the app from the repository root:

```sh
pnpm run dev
```

In a second shell, open the authenticated test session:

```sh
pnpm --filter frieren run verify:ui
```

This command creates or reuses a Clerk development user, seeds onboarding, and opens `http://localhost:5173` in the `frieren` session. Inspect only the changed flow. Use commands such as:

```sh
pnpm --filter frieren exec playwright-cli -s=frieren snapshot
pnpm --filter frieren exec playwright-cli -s=frieren console
pnpm --filter frieren exec playwright-cli -s=frieren requests
pnpm --filter frieren exec playwright-cli -s=frieren close
```

Use `fill` and `click` as needed.

## Check the sandbox reducer frame

After a change to `sandboxWorkerSource` in `packages/app/sandbox.ts` or the reducer frame in `apps/frieren/src/apps/sandbox.worker.ts`, run:

```sh
pnpm --filter frieren run verify:sandbox
```

This check confirms that the classic reducer Worker loads and answers the protocol in real browsers. If a required Playwright browser is missing, install it with:

```sh
pnpm --filter frieren exec playwright install chromium firefox webkit
```

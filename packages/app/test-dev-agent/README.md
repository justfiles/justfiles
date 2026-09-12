# Standalone dev agent smoke test

Build and pack `@justfiles/app`, copy this folder outside the monorepo, then install
dependencies with `pnpm init` and
`pnpm add /absolute/path/justfiles-app-<version>.tgz vite esbuild typescript valibot`.
Set `"type": "module"` in package.json and run `pnpm exec vite`. This test uses Claude's existing login and model configuration and
makes real model requests; it is deliberately outside the unattended test suite.

1. Click Research. Tick must remain responsive while the agent fetches the public
   source and writes the file through the app's declared volume binding.
2. Click Read saved file and verify the title and source URL.
3. Start another request and click Stop. The original request returns cancelled.
4. Restart Vite. Read saved file again; completed writes and the tick count survive.
   No request resumes automatically.
5. Start work and edit `src/app.ts`; the headless reload cancels the active request.
   A GUI-only edit or refresh must not cancel it.

The unit suite separately checks invalid output, inherited grants, slow writes,
process cleanup, deadlines, limits, readiness and cancellation races.

Verified on 2026-09-12 with Claude Code 2.1.263 and Sonnet selected using
`ANTHROPIC_MODEL=sonnet pnpm exec vite`. The installed default Opus 5 rejected the
readiness fixture; no saved model or login settings were changed.

# justfiles-app

A kernel app built on [`@justfiles/app`](https://www.npmjs.com/package/@justfiles/app).

```sh
pnpm install
pnpm dev      # develop
pnpm build    # emit dist/manifest.json, dist/app.js, dist/gui.js
```

## Local AI

If the app declares the `ai` capability, uncomment `devAi()` in `vite.config.ts`. With no
argument, it checks for `pi`, Claude Code, Codex, Ollama, and LM Studio in that order. The dev
server prints the backend that it selects.

You can select one backend or pass your own function:

```ts
devAi('claude-cli')
devAi('http://localhost:11434/v1')
devAi(async ({ system, prompt }) => generate(system, prompt))
```

## Publish to the Just Computer App Store

The [Just Computer](https://justcomputer.app) App Store is a search index over npm — there is no
submission form, no review queue, and no account with Just Computer. **Publishing to npm
is the submission.** Clients download your built bytes straight from npm's CDN
(jsDelivr) and verify them against hashes the indexer pinned at publish time.

1. Pick a bundle id. It is `<github-login>.<app>` and lives in `vite.config.ts`
   (`kernelHost({ id })`) — e.g. `alice.notes`. The GitHub user or organization must own
   the app repository; `justfiles.*` is reserved for first-party apps. The id is your
   app's permanent storage identity, so choose it once and keep it stable across
   versions.
2. `pnpm build` — the tarball ships the built `dist/` only (`files: ["dist"]`),
   and `prepublishOnly` rebuilds it for you on publish.
3. `npm publish` — the `justcomputer-app` keyword makes the indexer find you. Publish a
   new version to ship an update.

Notes:

- **Scoped names** (`@you/my-app`) publish privately by default; add
  `"publishConfig": { "access": "public" }` so the store can fetch your bytes.
- The indexer binds your app id to your npm package name on first publish
  (first claim wins), so keep both stable.
- Community apps are not reviewed by Just Computer; users see your declared capabilities
  and npm publisher on an install-consent sheet.

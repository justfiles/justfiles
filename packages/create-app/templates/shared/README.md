# JustFiles app

A standalone app built with [`@justfiles/app`](https://www.npmjs.com/package/@justfiles/app).
Start with [AGENTS.md](AGENTS.md) for the app model and skills on demand.

## Develop

Use Node 22.12+ (or 20.19+) and pnpm.

```sh
pnpm install
pnpm dev        # local app host; open the URL printed by Vite
pnpm check      # format/lint checks, types, tests, and production build
```

`src/app.ts` owns the state machine; `src/gui.ts` or `src/gui.tsx` owns the interface.
`src/app.test.ts` shows how to dispatch actions without a host. Update the starter tests as
behavior changes. Use `pnpm test --watch` while developing and `pnpm format` / `pnpm lint:fix` to
fix style issues. After checks, exercise the changed GUI flow in the local host.

The dev host saves files and reducer state in the git-ignored `.justfiles/dev/` folder,
so they survive restarts. App-scoped files are ordinary files under `data/<appId>/` inside
that folder; you can inspect and edit them with local tools. Leave the `.jfs/` metadata
alone. To reset local data, stop the dev server and delete `.justfiles/dev/`.

The package name comes from the directory. Set the app's name, description, and permanent
`<publisher>.<app>` id in `vite.config.ts`. A generated `local.*` id is for development;
choose your publisher id before distributing the app. Changing an installed app's id starts
separate storage. To add a launcher icon, put it in `public/` and set `kernelHost({ icon })`.

## Host development and AI

`pnpm build` emits `dist/manifest.json`, `dist/app.js`, `dist/gui.js`, and public assets.
`pnpm build --watch` also serves a local app store; use its printed URL with a host's development
store setting. In a JustFiles checkout, start Frieren with
`VITE_FRIEREN_DEV_APP_STORE=http://localhost:4173/store.json pnpm dev` (use the actual printed port).

For local AI, declare the `ai` capability and add `devAi()` from `@justfiles/app/vite` alongside
`kernelHost()` in `vite.config.ts`. The dev server prints its selected backend. Other capabilities
may need a full host; consult the authoring skill and installed SDK.

## Publish

Follow the [publishing skill](https://github.com/justfiles/skills/blob/main/skills/justfiles-app-publishing/SKILL.md)
for current release and catalog rules. Prepare the app identity, repository, license, icon, and
version for your app before publication.

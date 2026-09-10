# @justfiles/create-app

Create a JustFiles app without installing a global CLI:

```sh
pnpm dlx @justfiles/create-app my-app --id alice.my-app
pnpm dlx @justfiles/create-app my-app --template react --id alice.my-app
```

The default `vanilla` template uses plain DOM through `defineGUI`. The `react` template uses
`defineReactGUI` and bundles React into `gui.js`.

The generated project has a headless `src/app.ts`, a GUI, and `vite.config.ts`. It includes:

- A short `AGENTS.md` with the app model and links to the on-demand
  [JustFiles skills](https://github.com/justfiles/skills), plus a `CLAUDE.md` entry point.
- Biome formatting/linting, TypeScript checking (including Vite config), and Vitest with starter
  action tests. `pnpm check` runs these checks and builds the app.
- A README covering local development, host testing, AI, and the publishing skill.

Scaffolding needs no prompts or network access. Dependencies are installed with `pnpm install`.
Skills can be read directly through `AGENTS.md` or installed in the project with the command there;
the scaffolder does not install skills globally or vendor a copy of the platform guide.

`--id owner.app` sets the permanent app id. Without it, the id is `local.<directory-name>`;
choose a publisher id before distributing the app. The package and display names come from the
directory. Edit the display name and description in `vite.config.ts`.

The build emits `dist/manifest.json`, `dist/app.js`, `dist/gui.js`, and copied public assets.

Package-manager create commands work too:

```sh
npm create @justfiles/app my-app
pnpm create @justfiles/app my-app
pnpm create @justfiles/app my-app --template react
```

Other one-shot runners:

```sh
pnpm dlx @justfiles/create-app my-app
```

For local testing:

```sh
node packages/create-app/index.js .tmp/my-app --template react
```

When changing the scaffolder, run `pnpm run test packages/create-app/index.test.ts`.
When changing templates, generate both variants outside the workspace, install their dependencies,
and run `pnpm check` to verify the standalone package against the public SDK.

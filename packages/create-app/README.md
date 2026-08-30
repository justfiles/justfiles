# @justfiles/create-app

Create a JustFiles app without installing a global CLI:

```sh
npx @justfiles/create-app my-app
npx @justfiles/create-app my-app --template react
```

The default `vanilla` template uses plain DOM through `defineGUI`. The `react` template uses
`defineReactGUI` and bundles React into `gui.js`.

The generated project has a headless `src/app.ts`, a GUI, and `vite.config.ts`. Its build emits
`dist/manifest.json`, `dist/app.js`, `dist/gui.js`, and copied public assets.

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

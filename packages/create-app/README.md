# @justfiles/create-app

App generator for `@justfiles/app`.

It generates a headless `src/app.ts`, a GUI, and `vite.config.ts`. Builds emit `dist/manifest.json`, `dist/app.js`, `dist/gui.js`, and copied public assets.

The default `vanilla` template uses plain DOM through `defineGUI`. The `react` template uses `defineReactGUI` and bundles React into `gui.js`.

```sh
npm create @justfiles/app my-app
pnpm create @justfiles/app my-app
pnpm create @justfiles/app my-app --template react
```

Direct execution also works:

```sh
npx @justfiles/create-app my-app
pnpm dlx @justfiles/create-app my-app
```

For local testing:

```sh
node packages/create-app/index.js .tmp/my-app --template react
```

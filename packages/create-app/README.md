# @justfiles/create-app

Minimal create package for `@justfiles/app`.

It generates a headless `src/app.ts`, a framework-free `src/gui.ts` (plain DOM through `defineGUI`), and `vite.config.ts`. Builds emit `dist/manifest.json`, `dist/app.js`, `dist/gui.js`, and copied public assets.

A framework is yours to bring. Add it and its Vite plugin to bundle it into `gui.js`, or declare exact-version esm.sh URLs with `kernelHost({ imports })` to load browser packages at runtime.

```sh
npm create @justfiles/app my-app
pnpm create @justfiles/app my-app
```

Direct execution also works:

```sh
npx @justfiles/create-app my-app
pnpm dlx @justfiles/create-app my-app
```

For local testing:

```sh
node packages/create-app/index.js .tmp/my-app
```

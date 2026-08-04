# @justfiles/create-app

Minimal create package for `@justfiles/app`.

It generates a headless `src/app.ts`, a framework-free `src/gui.ts` (plain DOM through `defineGUI`), and `vite.config.ts`. Builds emit `dist/manifest.json`, `dist/app.js`, `dist/gui.js`, and copied public assets.

The platform serves no framework bytes, so a framework is yours to bring: add it plus its Vite plugin to the generated project and it bundles into `gui.js`. React is a special case today — `kernelHost()` still externalizes it and wraps a default-exported component from a `.tsx` GUI entry, so a React GUI only runs on a host that vendors React.

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

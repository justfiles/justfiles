# @justbuddy/create-app

Minimal create package for `@justfiles/app`.

It generates a headless `src/app.ts`, browser `src/gui.ts`, and `vite.config.ts` using the current `defineApp({ actions: ... })` and `kernelHost()` APIs. Builds emit `dist/manifest.json`, `dist/app.js`, `dist/gui.js`, and an importable `dist/bundle.js`.

```sh
npm create @justbuddy/app my-app
pnpm create @justbuddy/app my-app
```

Direct execution also works:

```sh
npx @justbuddy/create-app my-app
pnpm dlx @justbuddy/create-app my-app
```

For local testing:

```sh
node packages/create-app/index.js .tmp/my-app
```

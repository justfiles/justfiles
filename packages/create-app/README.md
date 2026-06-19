# @justfiles/create-app

Minimal create package for `@justfiles/app`.

It generates a headless `src/app.ts`, React `src/gui.tsx`, and `vite.config.ts`. The GUI can just default-export a React component; `kernelHost()` wraps it into the host GUI protocol. Builds emit `dist/manifest.json`, `dist/app.js`, `dist/gui.js`, and an importable `dist/bundle.js`.

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

# @justbuddy/create-app

Minimal create package for a vanilla TypeScript `@justfiles/app`.

Vite's `create-vite --template` only accepts templates bundled in `create-vite`.
Custom templates should use a create package, a GitHub template, or a local Bun
template instead.

After publishing this package:

```sh
npm create @justbuddy/app my-app
pnpm create @justbuddy/app my-app
bun create @justbuddy/app my-app
```

Direct execution also works:

```sh
npx @justbuddy/create-app my-app
pnpm dlx @justbuddy/create-app my-app
bunx @justbuddy/create-app my-app
```

For local testing:

```sh
node packages/create-app/index.js .tmp/my-app
```

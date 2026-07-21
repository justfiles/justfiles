# @spud-computer/pixel

An indexed pixel-art editor for the [spud](https://spud.computer) app store,
built on [`@justfiles/app`](https://www.npmjs.com/package/@justfiles/app). The
artwork lives in reducer state as a palette-indexed char grid, so an agent can
read and edit the picture directly.

```sh
pnpm install
pnpm dev      # develop
pnpm build    # emit dist/manifest.json, dist/app.js, dist/gui.js
```

Bundle id: `computer.spud.pixel`.

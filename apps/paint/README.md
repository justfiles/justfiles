# Paint

A persistent pixel drawing app for JustFiles.

Paint keeps its working document as a compact, replayable operation log. Strokes, shapes, fills,
undo, redo, and autosave remain local to the GUI; the app reducer stores only semantic tool and file
state.

## Develop

```sh
pnpm install
pnpm dev
```

`pnpm dev` boots a local host that emulates the JustFiles runtime, so no separate installation is
required.

## Check

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm format
```

## Build

```sh
pnpm build
```

The build writes `dist/manifest.json`, `app.js`, `gui.js`, and `icon.png`.

## Release

Bump `version` in `package.json` and merge to `main`. The release workflow verifies and builds the
app, then publishes the contents of `dist/` as `paint.zip` on a `v<version>` GitHub release.

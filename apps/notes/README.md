# Notes

A freeform knowledge base shared with the JustFiles agent.

Notes keeps a persistent scratch note ready for quick writing. It also supports folders, search,
note moves, and Obsidian ZIP imports.

## Develop

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts a local host that emulates the JustFiles runtime. The app does not need a
JustFiles installation for local development.

## Check

```sh
pnpm format
pnpm typecheck
pnpm lint:fix
pnpm test
```

## Build

```sh
pnpm build
```

The build writes the app bundle to `dist/`:

| File | Purpose |
| --- | --- |
| `manifest.json` | App identity, version, icon, and capabilities |
| `app.js` | Headless reducer that runs in a Worker |
| `gui.js` | Self-contained browser GUI with React and CSS |
| `icon.png` | Launcher icon |

The manifest version comes from `package.json`.

## Release

Increase `version` in `package.json` and merge the change to `main`.

The release workflow runs the checks, builds the app, creates `notes.zip` from the contents of
`dist/`, attaches build provenance, and creates the matching `v<version>` GitHub release.

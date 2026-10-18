# Files

Browse and preview files in JustFiles.

Files watches the JustFiles volume, shows its directory tree, previews text and images, and
tracks changes to the open file.

## Develop

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts a local host that emulates the JustFiles runtime.

To run this build in a local Frieren host, start the watch build:

```sh
pnpm build --watch
```

The build prints its local store URL. Start Frieren with that URL:

```sh
VITE_FRIEREN_DEV_APP_STORE=http://localhost:4173/store.json pnpm dev
```

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

The build writes the app bundle to `dist/`.

## Release

Increase `version` in `package.json` and merge the change to `main`.

The release workflow runs the checks, builds the app, and creates the matching
`v<version>` GitHub release.

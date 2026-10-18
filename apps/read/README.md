# Read

A read-later viewer over the shared `/reading` folder. The folder owns the documents and
`info.json` sidecars. The app keeps only a derived list, the open item, and the current text
selection in reducer state.

Item folders keep readable title-based names. A hidden `/.index` tree maps SHA-256 identities to
those folders, so repeated URLs, pasted text, and PDFs can be found without scanning the library.
`refresh` adds missing index entries for folders saved by older versions.

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

URL extraction uses the host's `reader` capability. Pasted Markdown and files added through Files
work without network access.

Press Command-V or Control-V anywhere in the app to save a URL, a PDF, or text with at least 200
characters. Saving a URL already in the library opens the existing item instead of fetching it again.

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

# Draw

A freeform sketchpad backed by [Excalidraw](https://excalidraw.com), built as a JustFiles app.

Frames double as slides: `orderFrames` sorts them by reading order rather than z-order, so a
board can be presented without rearranging it.

## Develop

```sh
pnpm install
pnpm dev          # vite dev server with an in-memory kernel host
```

`pnpm dev` boots a local host that emulates the real runtime, so the app runs standalone —
no JustFiles install required.

## Check

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm format       # writes
```

## Build

```sh
pnpm build
```

Emits the app bundle into `dist/`:

| File | What it is |
| --- | --- |
| `manifest.json` | id, name, version, icon, declared capabilities |
| `app.js` | the headless reducer, run in a Worker |
| `gui.js` | the browser GUI, self-contained (React and CSS inlined) |
| `icon.png` | copied from `public/` |

`manifest.json`'s `version` is read from `package.json`, so the package version is the single
place a release version is set.

`gui.js` is large (~10 MB, ~3 MB gzipped) because it carries Excalidraw. That is an inert
static asset, not executable Worker code — `app.js`, the only file that becomes a Worker, is
under 12 KB.

### Fonts

The build embeds Excalidraw's small fonts into `gui.js`, so they work inside the app frame and
offline. Xiaolai's Unicode subsets are about 13 MB, so they remain on Excalidraw's
`esm.sh` fallback and load only when Chinese glyphs need them. A host must permit
`https://esm.sh` in `font-src`; offline clients use a fallback unless that subset is browser-cached.

## Release

Bump `version` in `package.json` and merge to `main`. That is the whole ritual.

`.github/workflows/release.yml` notices a version with no matching tag, runs the checks, builds,
zips the contents of `dist/` into `draw.zip`, attaches a build-provenance attestation, and cuts
the GitHub release at `v<version>`. Every other push to `main` is a no-op, so the workflow is safe
to run on every merge.

The asset name is not a convention — the catalog importer takes the sole `*.zip` on a release, so
it can be whatever describes the app.

Because the tag is derived from `package.json` rather than pushed by hand, the release tag and
`manifest.json`'s version cannot drift apart.

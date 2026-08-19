# Icon

A focused icon creator backed by [Excalidraw](https://excalidraw.com), built as a
JustFiles app.

The editor remains an infinite Excalidraw canvas. A fixed, centred viewport window defines the
1024 × 1024 icon output: users pan and zoom the artwork behind that window, then export exactly
what it shows as PNG or SVG. Zoom is part of the composition—a 20-unit drawing enlarged to fill
the window is scaled across all 1024 output pixels, including its stroke widths. Live previews
show how the result reads from 256px down to 16px.

**Grid** overlays Apple's app icon keyline grid on the output window: the icon squircle, three
concentric circles, five horizontal and five vertical rules, and both diagonals. The geometry is
measured from Apple's own drawing of the grid (WWDC 2017 session 822, "App Icon Design", slide 55)
and normalised to 1024 px in `src/ios-grid.ts`, which documents how it is constructed. Like the
output window it is host UI — `pointer-events: none`, never a scene element, and never exported.

The output window is application UI rather than a saved Excalidraw element. This keeps it fixed
while Excalidraw zooms and pans behind it, and prevents it from being selected, resized, or
deleted. Its scene-space camera bounds are saved in an ignored root-level `icon` settings object,
so projects remain valid `.excalidraw` JSON and gallery previews reproduce the same composition.
The grid toggle rides along in the same object.

## Develop

```sh
pnpm install
pnpm dev
```

`pnpm dev` boots a local host that emulates the JustFiles runtime.

## Check

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Build

The build emits a self-contained JustFiles app into `dist/`:

| File | What it is |
| --- | --- |
| `manifest.json` | App identity, version, icon, and declared capabilities |
| `app.js` | The headless file/persistence reducer |
| `gui.js` | React, Excalidraw, CSS, and fonts in one browser module |
| `icon.svg` | Catalog/launcher artwork copied from `public/icon.svg` |

Excalidraw's small fonts are embedded in `gui.js` so the editor and exported SVGs work inside
the app frame and offline. Xiaolai's much larger Unicode subsets retain Excalidraw's `esm.sh`
fallback.

## Release

Bump `version` in `package.json` and merge to `main`. The release workflow verifies the app,
builds `icon.zip`, attests it, and creates the corresponding `v<version>` GitHub release.

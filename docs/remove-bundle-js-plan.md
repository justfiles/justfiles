# Remove `dist/bundle.js`

## Goal

Stop generating and importing `dist/bundle.js` for built-in apps.

`bundle.js` is a generated JS module that embeds every built app file as base64 so a host
can `import code from '@justfiles/app-code/bundle'`. That was convenient when built-ins
were small, but it is the wrong transport for app-code's future devkit sysroot: it bloats
bytes, parses them as JS, and keeps all built-in files in module memory.

Built app files already exist as normal files before installation. Hosts should seed
built-ins from those files directly, using an explicit bundle root instead of a generated
byte module.

## Current State

- `packages/app/vite.ts` emits `dist/bundle.js` and `dist/bundle.d.ts` in `kernelHost()`.
- built-in app packages export `./bundle` from package.json.
- `apps/quay/quayd/builtins.ts` imports `@justfiles/app-*/bundle`.
- `apps/desktop/src/main/builtins.ts` imports `@justfiles/app-*/bundle`.
- Frieren is already file-backed: `apps/frieren/vite-appstore.ts` walks each built app's
  build output and explicitly skips `bundle.js` / `bundle.d.ts`.
- The kernel install path already supports arbitrary extra app files: `AppBundle.list()`
  files are copied into `/applications/<id>/...`.

## Target Shape

An installable app bundle is a directory or zip whose root contains `manifest.json`. The
root does not have to be named `dist`; `dist/` is only what `kernelHost()` happens to emit
today.

The app manifest should be package-like: it names runtime entry points and may whitelist
extra files to include.

```json
{
	"id": "app.code",
	"name": "Code",
	"app": "app.js",
	"gui": "gui.js",
	"icon": "icon.png",
	"include": ["devkit/**"]
}
```

`app`, `gui`, `cli`, `icon`, and `manifest.json` are always included. `include` adds extra
files such as app-code's devkit sysroot. This keeps package source roots safe: a root can
contain `src/`, configs, tests, or other local files without all of them becoming installed
app assets.

Each host gets a catalog of built-in app files:

```ts
type BuiltinSource = {
	catalog: Catalog
	read(app: CatalogApp, path: string): Promise<Uint8Array>
}
```

The catalog lists the resolved install files: `manifest.json`, `app.js`, `gui.js`, icons, and
any `include` matches such as `devkit/**`. `reconcileBuiltins(kernel, fs, catalog, read)`
remains the common install path.

## Plan

### 1. Add a file-backed builtins helper

Add a small helper outside host-specific code, probably in `@justfiles/app/builtins` or a new
sibling module:

- input: explicit bundle root directories;
- read each `<root>/manifest.json`;
- include `manifest.json` plus the manifest's `app` / `gui` / `cli` / `icon` paths;
- expand manifest `include` globs for extra files;
- skip generated helper files while they still exist: `bundle.js`, `bundle.d.ts`;
- compute `sha256-...` hashes;
- return `{ catalog, read }`.

Keep it host-agnostic. It should work against a real filesystem path and not know about quay,
desktop, frieren, or the name of the build output directory.

### 2. Move quay built-ins off `./bundle`

Replace `apps/quay/quayd/builtins.ts` with a file/resource-backed source.

Development:

- read from an explicit list of workspace bundle roots;
- for today's `kernelHost()` apps those roots will be `packages/app-*/dist`;
- if a root is missing `manifest.json`, fail with a clear "build the app first" error.

Shipped Quay.app:

- copy built-in bundle roots into `Contents/Resources/builtins/<app-id>/` during the quay
  build/asset step;
- load the catalog/read bytes from that resource directory;
- keep `reconcileBuiltins()` unchanged.

This is the critical migration because app-code's future `devkit/**` files should be read as
normal files, not embedded in a generated JS module.

### 3. Move desktop built-ins off `./bundle`

Apply the same pattern to `apps/desktop/src/main/builtins.ts`.

If desktop packaging already has a resource-copy step, copy built-in bundle roots there. If
not, start with dev-time filesystem reads and add packaged resources before desktop ships.

### 4. Keep Frieren as-is, then optionally dedupe

Frieren already walks built app output files directly in `apps/frieren/vite-appstore.ts`.

After quay and desktop use the shared file-backed helper, consider refitting Frieren's appstore
builder to reuse the same catalog walk logic. This is cleanup only; it should not block removal.

### 5. Remove `bundle.js` generation

Once no host imports `@justfiles/app-*/bundle`:

- delete `emitBuiltinBundle()` from `packages/app/vite.ts`;
- remove the `emitBuiltinBundle(out, manifest)` call from `kernelHost()`;
- stop writing `dist/bundle.js` and `dist/bundle.d.ts`.

At this point app builds emit only real files:

```text
dist/
  manifest.json
  app.js
  gui.js
  icon.png
  devkit/...
```

`dist/` remains an output directory used by `kernelHost()` and `create-app`, not a platform
bundle convention.

### 6. Remove package exports

Remove the `./bundle` export from built-in app package manifests:

- `packages/app-code/package.json`
- `packages/app-counter/package.json`
- `packages/app-files/package.json`
- `packages/app-notes/package.json`
- `packages/app-paint/package.json`
- `packages/app-settings/package.json`
- `packages/create-app/template/package.json`

Also remove `BuiltinBundle` if nothing else uses it.

### 7. Update docs and tests

Update docs that mention `bundle.js`:

- `packages/create-app/README.md`
- `packages/app/README.md`
- quay/desktop design docs that describe built-in bundle imports.

Update tests around built-in seeding to exercise file-backed catalogs. Keep the existing
`reconcileBuiltins()` tests; they should remain valid because the common install path stays the
same.

## Verification

After each migration step:

```sh
pnpm format
pnpm typecheck
pnpm lint:fix
pnpm test
```

Quay-specific smoke:

```sh
pnpm --filter @justfiles/quay build
```

Then launch Quay and verify built-ins are seeded, Code opens, and app-code can run a starter
preview.

## Notes

- Prefer `include` over inferring a root from the `app` / `gui` parent directories. Parent
  inference is ambiguous: it either misses files outside `src/` or accidentally installs
  source/config/test files when the parent is the package root.
- Do not add an `assets` field to `manifest.json` just for this. The kernel already installs
  every file returned by `AppBundle.list()`; `include` is only package-like metadata used by
  file-backed bundle readers to decide what belongs in that list.
- A `devkit/manifest.json` inside app-code's installed files is still useful because
  `Kernel.app(id)` exposes `read(path)`, not `list()`.
- The app manifest should continue to name only runtime entry points and app metadata.

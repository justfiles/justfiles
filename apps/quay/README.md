# quay

The native macOS shell + the `quayd` daemon. The AppKit launcher (`native/`) spawns
`quayd`, which serves every app's UI over http and projects each installed app into a
thin `.app` under `~/Applications/Quay Apps/`. Architecture lives in [DESIGN.md](./DESIGN.md);
the Node→Bun runtime migration in [BUN-MIGRATION-PLAN.md](./BUN-MIGRATION-PLAN.md).

## Prerequisites

- macOS on Apple Silicon (the ship target is arm64-only for now).
- Xcode **Command Line Tools** (`swift build` compiles the native shell — no full Xcode).
- [bun](https://bun.sh) on `PATH` (the prod build; the `bun` dev runtime is optional).
- `pnpm install` at the repo root.

## Scripts

Run from `apps/quay`. Each `dev`/`build` first builds quay's workspace app dependencies
(`turbo run build --filter=@justfiles/quay^...`, cached) and the web assets, so a single
command leaves you with a runnable app — there is no separate `assets`/`reseed` step.

| Command            | What it does                                                                                                                     |
|--------------------|----------------------------------------------------------------------------------------------------------------------------------|
| `pnpm dev`         | Build a **dev** `native/Quay.app` that runs `quayd` from source (node), then kill any running quay and relaunch. The inner loop. |
| `pnpm build`       | Build the **production** self-contained `native/Quay.app` (bun exe + bundled assets).                                            |
| `pnpm start`       | `open` the built `native/Quay.app` (no rebuild, no kill).                                                                        |
| `pnpm install:app` | `build`, then replace `/Applications/Quay.app` and open it. Kills the running copy first.                                        |
| `pnpm quayd`       | Run the daemon headless (node), no native window — e.g. for a browser client.                                                    |

> `install:app`, not `install`: a script named `install` is an npm/pnpm lifecycle hook and
> would fire on every `pnpm install`.

### Dev loop

```sh
pnpm dev
```

The launcher spawns `quayd` from source — no packaging. The daemon re-seeds the built-in
apps from their freshly built `dist/bundle.js` on every boot, so `pnpm dev` (which rebuilds
the app deps, then kills + relaunches) always shows current code. Editing only `quayd/*`
needs just a relaunch; `quayd` runs under node via tsx, no build.

By default the dev launcher spawns `quayd` under **node** (`node --import rawLoader --import
tsx quayd/main.ts`) — the escape hatch. To spawn it under **bun** (`bun quayd/main.ts`),
re-stamp the bundle and relaunch:

```sh
native/build.sh --runtime bun --launcher && native/relaunch.sh
```

`--runtime` is the only knob — Swift never changes. The launcher stamps `QuaydRuntime` /
`QuaydArgs` / `QuaydScript` into its `Info.plist` and `Quayd.spawn()` execs them verbatim
(the reversibility hinge).

### Production build & install

```sh
pnpm build          # → native/Quay.app (self-contained, arm64)
pnpm install:app    # build + install to /Applications

# For an actual release, optimise the native shell too:
native/build.sh --release --ship
```

`pnpm build` produces a **self-contained, relocatable** `Quay.app` that needs no system
node/bun, no tsx, no repo, and no esbuild. It assembles:

- **`Contents/MacOS/quayd`** — `quayd` compiled into one ~74MB Mach-O exe that embeds Bun +
  the whole daemon graph (`bun quayd/build-exe.ts --target bun-darwin-arm64`, via the
  `Bun.build` JS API so the agent's `*.md?raw` prompts get a text-loader plugin). Because
  `Bun.build` is in-process, install-time devkit compiles need no external toolchain.
- **`Contents/Resources/assets-dist/`** — the vendor/boot/chat bundles + agent docs.
- **`Contents/Resources/design/`** — the `@justfiles/design` stylesheets served at `/design`.
- **`Contents/Resources/build/`** — the shared booter binary + icon tool that `quayd` copies
  per app when projecting `.app`s.

The exe is built with `define: process.env.QUAY_SHIPPED='1'`, so `quayd/resources.ts`
resolves every on-disk path from `Contents/Resources` next to `process.execPath` instead of
the repo. That one file is the only dev-vs-shipped seam. The launcher stamps a
bundle-relative `QuaydRuntime=quayd` (no args, no script), so the bundle stays relocatable.

**Notes**

- **arm64 only.** `--ship` hardcodes `--target bun-darwin-arm64` (x64 / universal not wired
  up yet).
- **Bun only.** A reversible **node** production target (esbuild-bundle `quayd` + an embedded
  node binary) is the planned counterpart but is **deferred** — see BUN-MIGRATION-PLAN.md.
  The node *dev* path is unaffected and remains the escape hatch.

Prove the bundle is self-contained by relocating it away from the repo and node/bun:

```sh
cp -R native/Quay.app /tmp/Quay.app
open -n /tmp/Quay.app    # boots; serves /vendor + /design from Contents/Resources via execPath
```

After running a prod build, `pnpm dev` returns you to the dev launcher; the projected
`~/Applications/Quay Apps/*.app` booters self-heal on the next daemon boot — they re-stamp
to whichever runtime is now serving.

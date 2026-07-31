# Kodama for Mac

The native macOS shell + the daemon (`daemon/`). The AppKit launcher (`native/`) spawns
the daemon, which serves every app's UI over http and projects each installed app into a
thin `.app` under `~/Applications/Kodama Apps/`. Architecture lives in [DESIGN.md](./DESIGN.md);
the Node→Bun runtime migration in [BUN-MIGRATION-PLAN.md](./BUN-MIGRATION-PLAN.md).

## Prerequisites

- macOS on Apple Silicon (the ship target is arm64-only for now).
- Xcode **Command Line Tools** (`swift build` compiles the native shell — no full Xcode).
- [bun](https://bun.sh) on `PATH` (the prod build; the `bun` dev runtime is optional).
- `pnpm install` at the repo root.

## Scripts

Run from `apps/mac`. Each `dev`/`build` first builds the workspace app dependencies
(`turbo run build --filter=@justfiles/frieren-mac^...`, cached) and the browser surfaces, so a single
command leaves you with a runnable app — there is no separate `assets`/`reseed` step.

| Command            | What it does                                                                                                                     |
|--------------------|----------------------------------------------------------------------------------------------------------------------------------|
| `pnpm dev`         | Vite watch (`ui/dist/client`) + `bun --watch daemon/main.ts` — the daemon headless on `:3000`, no native window. The inner loop; open a browser, or run the launcher (below). |
| `pnpm build`       | Build the **production** self-contained `native/Kodama.app` (bun exe + Vite client).                                            |
| `pnpm start`       | `open` the built `native/Kodama.app` (no rebuild, no kill).                                                                        |
| `pnpm install:app` | `build`, then replace `/Applications/Kodama.app` and open it. Kills the running copy first.                                        |

> `install:app`, not `install`: a script named `install` is an npm/pnpm lifecycle hook and
> would fire on every `pnpm install`.

### Dev loop

```sh
pnpm dev
```

This runs the **daemon** from source (`bun --watch daemon/main.ts`) alongside a Vite watch
that rebuilds its browser surfaces into `ui/dist/client` — both hot-reload on edit, served
headless on `:3000`. For the native window, build + relaunch the dev launcher:

```sh
native/build.sh --launcher && native/relaunch.sh
```

`--launcher` builds `ui/dist/client` once (the daemon serves it via `CLIENT_DIR`) and stamps
the launcher's `Info.plist` to spawn the daemon from source under **bun** (`bun
daemon/main.ts`). The daemon is Bun-only (`Bun.serve` / pub-sub / `Bun.file`), so there is no
node escape hatch here. `Daemon.spawn()` (Launcher.swift) execs the stamped `DaemonRuntime` /
`DaemonArgs` / `DaemonScript` verbatim — the runtime choice lives in the plist, never in Swift.
The daemon re-seeds the built-in apps from their freshly built `dist` files on every boot, so
a relaunch always shows current code; editing only `daemon/*` needs just the relaunch.

### Production build & install

```sh
pnpm build          # → native/Kodama.app (self-contained, arm64)
pnpm install:app    # build + install to /Applications

# For an actual release, optimise the native shell too:
native/build.sh --release --ship-daemon
```

`pnpm build` produces a **self-contained, relocatable** `Kodama.app` that needs no system
node/bun and no repo. It assembles:

- **`Contents/MacOS/daemon`** — the daemon compiled into one Mach-O exe that embeds Bun +
  the whole daemon graph (`bun daemon/build-exe.ts --target bun-darwin-arm64`, via the
  `Bun.build` JS API so the agent's `*.md?raw` prompts get a text-loader plugin). Because
  `Bun.build` is in-process, install-time devkit compiles need no external toolchain.
- **`Contents/Resources/client/`** — the Vite-built browser surfaces (launcher / chat / app
  shell + hashed `/assets/*` + the shared React `/vendor/*` bundles), served via `CLIENT_DIR`.
- **`Contents/Resources/builtins/`** — the built-in app bundle roots the daemon seeds.
- **`Contents/Resources/build/`** — the shared booter binary + icon tool that the daemon copies
  per app when projecting `.app`s.

The exe is built with `define: process.env.FRIEREN_SHIPPED='1'`, so `daemon/resources.ts`
resolves every on-disk path from `Contents/Resources` next to `process.execPath` instead of
the repo. That one file is the only dev-vs-shipped seam. The launcher stamps a
bundle-relative `DaemonRuntime=daemon` (no args, no script), so the bundle stays relocatable.

**Notes**

- **arm64 only.** `--ship-daemon` hardcodes `--target bun-darwin-arm64` (x64 / universal not
  wired up yet).
- **Bun only.** The daemon is Bun-native (`Bun.serve` / pub-sub / `Bun.file`); there is no
  node production target. The node *dev* path is gone too — dev runs under bun.

Prove the bundle is self-contained by relocating it away from the repo and node/bun:

```sh
cp -R native/Kodama.app /tmp/Kodama.app
open -n /tmp/Kodama.app    # boots; serves /vendor + /design from Contents/Resources via execPath
```

After running a prod build, `pnpm dev` returns you to the dev launcher; the projected
`~/Applications/Kodama Apps/*.app` booters self-heal on the next daemon boot — they re-stamp
to whichever runtime is now serving.

## Signing in to Kodama

`/sign-in` in the launcher opens the browser on **Clerk's** own sign-in page and catches the
redirect on 127.0.0.1: the daemon is an OAuth 2.0 public client of our Clerk instance (PKCE,
no client secret — see `daemon/identity.ts` and #304). The refresh token lives in the
Keychain; every request to our API carries a short-lived access token minted from it.

```sh
security find-generic-password -s app.justfiles.kodama -a kodama-oauth   # the stored grant
```

`/sign-out` revokes the grant and deletes that item. Local data is never touched by either.

The dev daemon talks to the **development** Clerk instance and a shipped one to production
(`daemon/identity.ts`; `KODAMA_CLERK_FAPI` / `KODAMA_CLERK_CLIENT_ID` override both). The two
OAuth applications already exist; this is how they were created, and how to recreate one:

```sh
clerk api -X POST /oauth_applications --instance dev \
  -d '{"name":"Kodama for Mac","public":true,"scopes":"profile email",
       "redirect_uris":["http://127.0.0.1:1455/auth/callback"]}'
clerk api -X PATCH /oauth_applications/<id> --instance dev \
  -d '{"pkce_required":true,"consent_screen_enabled":false}'
```

`offline_access` is added by Clerk. The registered **port is ignored** for `127.0.0.1` (RFC
8252 §7.3), which is why the daemon can keep binding an OS-assigned port — but the **host and
path must match exactly**, so `/auth/callback` is fixed and `localhost` would be refused. The
client id is public (that is what PKCE is for) and is pinned worker-side in
`apps/frieren/worker/auth.ts`, so a token from any other OAuth app on the instance is refused.

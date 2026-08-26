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

Run from `platform/mac`. `turbo run …` here is auto-scoped to this package. Turbo builds the
workspace dependencies and browser surfaces first.

| Command                | What it does                                                                                                                     |
|------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| `turbo run dev`        | Vite watch (`ui/dist/client`) + `bun --watch daemon/main.ts` — the daemon headless on `:3000`, no native window. The inner loop; open a browser, or run the launcher (below). |
| `turbo run build`      | Build the **production** self-contained `native/Kodama.app` (bun exe + Vite client).                                            |
| `pnpm start`           | `open` the built `native/Kodama.app` (no rebuild, no kill).                                                                        |
| `pnpm install:app`     | `build`, then replace `/Applications/Kodama.app` and open it. Kills the running copy first.                                        |

> `pnpm dev` and `pnpm build` are leaf scripts. Use `turbo` or the root `pnpm build` to
> build workspace dependencies first.

> `install:app`, not `install`: a script named `install` is an npm/pnpm lifecycle hook and
> would fire on every `pnpm install`.

### Dev loop

```sh
turbo run dev
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
The daemon reconciles the hosted apps it seeds from JustApps on every boot. Editing only
`daemon/*` needs just the relaunch.

## App storage

The Volume's `/applications` tree is the installed-app source of truth. An app has one of two storage
shapes:

- A JustApps manifest has an immutable `baseUrl`. The Volume keeps `manifest.json` and the reducer
  (`app.js`). The daemon downloads the GUI, icon, and other mounted files into
  `/private/cache/apps/<sha256-of-url>` and checks their manifest hashes before use.
- A local app has no `baseUrl`. The Volume keeps its full bundle because there is no server from which
  the daemon can restore missing files. App Code installs use this shape.

The shared install and reconcile paths prefetch hosted files. A hosted app therefore works offline
after the prefetch succeeds. The cache is local, derived data under `/private`, so it does not sync.
The thin bundles in `~/Applications/Kodama Apps/` are also derived data. They contain no app code.

### What a fresh Volume starts with

The hosted apps `daemon/builtins.ts` names in `SEEDED`: **Files**, **Settings**, **Notes**, and
**Paint**.

Everything else JustApps publishes, **Code** and **Draw** included, installs from the App Store tile.
A seeded app is also a trusted one (`reconcile` updates it without asking), so the seed list stays the
smallest set this Mac wants on day one.

### The App Store tile

The launcher's last grid tile browses everything JustApps publishes. The daemon owns both ends:
`GET /store` lists the catalog (index plus each published manifest, no file lists), and
`POST /store/<id>?version=<v>` installs one app, so no app bytes pass through the
webview. A row asks for consent first, showing the access the published manifest declares, and the
install lands the release that listing resolved rather than re-resolving the registry: a publisher
who moves the pointer after the sheet renders — even to a different release under the same version
— cannot slip past the consent it showed. A cross-origin `POST` is rejected, because loopback is
reachable from any browser on this Mac. That is not authorization, though: an installed app's
`gui.js` runs in a daemon-origin document, so any app page is same-origin with the launcher and can
install (as it can drive every other daemon socket). One gate for the whole surface needs app
documents off this origin — see `tasks/mac-daemon-loopback-auth.md`. An install fires
`app.installed`, which pushes a fresh catalog to every launcher, so the new app appears in the grid
and its row leaves the list.

One surface, two shells. The web launcher renders it inline; the native launcher has an AppKit
springboard, so its store tile reveals `/launcher/store` — the same React surface in a WKWebView,
the way it already embeds the chat. Done posts back over the `store` message handler (Escape works
too); the page reloads on every open, because it fetches the published catalog on mount and a
second visit must not show the first visit's snapshot.

The list also carries a **held update**: a published release that asks for more access than the
installed one — a version bump or a release replaced in place — which `reconcile` skips rather than
applying. Accepting the row is the re-consent,
and this list is the only place on this Mac where one surfaces.

### Production build & install

```sh
turbo run build   # → native/Kodama.app (self-contained, arm64)
pnpm install:app  # build + install to /Applications

# For an actual release, optimise the native shell too:
native/build.sh --release --ship-daemon
```

`turbo run build` produces a **self-contained, relocatable** `Kodama.app` that needs no system
node/bun and no repo. It assembles:

- **`Contents/MacOS/daemon`** — the daemon compiled into one Mach-O exe that embeds Bun +
  the whole daemon graph (`bun daemon/build-exe.ts --target bun-darwin-arm64`, via the
  `Bun.build` JS API so the agent's `*.md?raw` prompts get a text-loader plugin). Because
  `Bun.build` is in-process, install-time devkit compiles need no external toolchain.
- **`Contents/Resources/client/`** — the Vite-built browser surfaces (launcher / chat / app
  shell + hashed `/assets/*` + the shared React `/vendor/*` bundles), served via `CLIENT_DIR`.
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
Keychain; every request to our API carries a short-lived access token minted from it. Signing in
also turns on the plan-backed Kodama AI for app capabilities and launcher chat; a local ChatGPT
account can still be selected instead in Settings.

```sh
# the stored grant — one item per Clerk instance, so a source daemon and a shipped app
# never share (or destroy) each other's:
security find-generic-password -s app.justfiles.kodama -a kodama-oauth.clerk.mykodama.app
security find-generic-password -s app.justfiles.kodama \
  -a kodama-oauth.capable-spider-79.clerk.accounts.dev   # …the dev instance's
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
`platform/frieren/worker/auth.ts`, so a token from any other OAuth app on the instance is refused.

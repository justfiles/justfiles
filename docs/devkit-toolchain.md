---
title: 'Devkit Toolchain'
description: How the devkit capability builds apps from source — one shared factory, a swappable compile/typecheck toolchain, and a per-host runner for live previews.
---

# Devkit Toolchain

Devkit is the capability the Code app uses to build apps from source: compile and
type-check a project, run it as a live preview, install it as an app, or pack it as a zip.
It runs code and can write `/applications`, so hosts give it only to trusted apps.

Its functions split on one question: **is it a file transform, or is it a running app?**

- **File transforms**, `compile` and `typecheck`, are pure: project files in, artifacts and
  diagnostics out. They make up the **toolchain**, which each host runs off its main thread.
- **Running a draft**, mounting the preview and stopping it, needs the host's kernel and
  window system. That is the **runner**.

Everything else (`install`, `pack`, the build half of `run`) is shared glue around those
two seams.

## Projects

A project is a directory in the calling app's own data dir,
`/data/<appId>/projects/<slug>/`:

- `project.json`: the build contract. An `AppManifest` (`id`, `name`, `app`, optional `gui`
  and `icon`) whose entry paths point at the sources, plus an optional `imports` map of URL
  imports and compiler options such as `jsx`.
- The source tree.
- `devkit-lock.json`: the resolved URL imports, written by devkit.

Callers name a project by `slug` only. Devkit reads the tree itself, so no file bytes
cross the app's worker boundary.

## The shared factory

`devkitCapability` in `packages/app/capabilities/devkit/host.ts` implements the whole
app-facing contract. A host supplies:

```ts
devkitCapability({
	fs,          // the Volume
	kernel,      // to read the calling app's bundle and install drafts
	compile,     // (input, runtime, imports?) => CompileResult
	typecheck,   // optional: (input, types, paths, imports?) => CheckResult
	imports,     // optional: { cache, fetch? } for project URL imports
	runner,      // { mount, stop }
	overwrite    // optional: let install replace an existing app
})
```

For each call the factory:

1. Reads the project and shapes it as a `ProjectInput`: a file map, the named entries, and
   a generated tsconfig.
2. Loads the **platform SDK** from the calling app's installed bundle (below), once per app.
3. Resolves the project's URL imports, if any, against the host's cache and the lock file.
4. Runs `compile` or `typecheck`, then builds, installs, packs or mounts on top.

Calls for one project run one at a time. `run` hands the runner only a clean build; on a
compile error the last good preview stays mounted and the diagnostics come back. A host
that passes no `typecheck` gets `CAPABILITY_UNAVAILABLE` for it. A host that passes no
`imports` fails projects that declare URL imports with `IMPORT_UNAVAILABLE`.

Diagnostics are LSP-shaped with 0-based positions, so editors consume them directly.

### The platform SDK (sysroot)

The Code app ships the SDK a draft compiles against under `devkit/**` in its own bundle
(`packages/app/capabilities/devkit/devkit-sysroot.ts`): `devkit/index.json` maps
declaration files for type checking and runtime modules for bundling to content-addressed
blobs under `devkit/store/`. Because each installed Code version carries its own SDK, a
host needs no `node_modules` or package resolver, and a project's imports can never
replace a platform module.

A compiled draft inlines everything it uses: the SDK and valibot come from the sysroot's
runtime modules, so `app.js` and `gui.js` are self-contained and no host serves framework
bytes. A draft's GUI is plain DOM through `defineGUI`, unless the project's import map
pins a UI framework.

## The toolchain

The pieces live in `packages/app/capabilities/devkit/` and are exported as
`@justfiles/app/toolchain/*`:

| Module | What it does |
|----|----|
| `toolchain.vfs.ts` | Bundler-agnostic resolve and load rules over the file map |
| `toolchain.esbuild.ts` | `compile` with esbuild (native or wasm, injected) |
| `toolchain.bun.ts` | `compile` with `Bun.build` |
| `toolchain.typescript.ts` | `typecheck` with the TypeScript compiler API over an in-memory host |
| `toolchain.worker.ts` | `serveToolchain` and `toolchainClient`: one message protocol for running the toolchain in a worker |

The web and Mac hosts run their toolchain in a worker through `toolchain.worker.ts`, so a
multi-second type check never blocks the host's main thread. URL fetches stay on the host
side, which owns the import cache and lock; the worker gets the resolved graph.

## Hosts

| | Web (`platform/frieren`) | Mac (`platform/mac`) | App dev server (`packages/app`) |
|----|----|----|----|
| Where the toolchain runs | a lazy Web Worker in the browser | a warm Bun worker in the daemon | in the dev server process |
| `compile` | esbuild-wasm | `Bun.build` | native esbuild |
| `typecheck` | TypeScript, with its `lib.*.d.ts` bundled | TypeScript | TypeScript |
| URL imports | cached in Cache Storage | not supported | cached on disk |
| Preview | the draft installs into a scoped kernel under `/data/<appId>/.devkit/<slug>` and opens as its own window (`{ kind: 'window' }`) | the draft installs into the daemon's kernel and Code embeds `/app/<previewId>` (`{ kind: 'url' }`) | served at `/_preview/<previewId>/` (`{ kind: 'url' }`) |
| Install over an existing app | rejected | allowed | allowed |
| Who may call it | apps that declare it and are in `DEVKIT_ALLOWLIST` | any app that declares it | any app that declares it |

A preview runs under the hidden kernel id `.preview.<slug>` (`previewIdFor`). The leading
dot keeps it off the launcher catalog, so rebuilding a preview never wakes a launcher.

On the web, devkit runs only in the browser: the server-side agent cannot compile or type
check while no tab is open.

## The agent

The agent has no devkit tool of its own. It reaches devkit through the Code app's public
actions, such as its `typecheck` procedure (`apps/code/src/app.ts`), which become agent
tools like any app's actions. So the agent sees the same diagnostics as the Problems panel.

---
project: packages/app, apps/frieren
status: todo
---

# devkit: browser packages and type checking

## Result

App Code can build a React app, check its types, run its preview, install it, and export it
without a container. Frieren does the build and type check in the browser.

The finished app contains its dependencies in `app.js` and `gui.js`. It does not contact a
package CDN when it runs.

This work does not make Devkit compatible with npm or Vite. Devkit supports a smaller model:
exact HTTPS module imports, a local cache, esbuild-wasm, and TypeScript in a Web Worker.

## Current state

Devkit already has most of the build path:

- `packages/app/capabilities/devkit/devkit.ts` reads a project from the caller's volume.
- `toolchain.esbuild.ts` builds it from virtual files and a fixed platform runtime.
- `toolchain.typescript.ts` checks it when a Node host supplies TypeScript.
- `toolchain.worker.ts` has a transport-neutral worker protocol for compile and type-check
  requests.
- Frieren uses esbuild-wasm, but it runs the compiler on the UI thread and does not supply a
  type checker.
- App Code already shows build and type diagnostics returned by the Devkit capability.

The local app-store path has landed. An external app repository can run `pnpm build --watch`,
and Frieren can load its output through `VITE_FRIEREN_DEV_APP_STORE`.

Two local-store fixes must land before this work starts:

1. The local store must install any app ID in its manifest. It must not use the production
   `BUILTIN_IDS` list to decide which local apps exist.
2. A local build must replace the installed copy even when its version is lower. A developer
   must be able to test an older branch.

## Ownership

Frieren owns a dedicated toolchain Web Worker. This is not the worker that runs a preview app.

```text
App Code
	|
	| devkit.compile, devkit.typecheck, devkit.run
	v
Frieren Devkit capability
	|
	+-- toolchain Web Worker
	|     esbuild-wasm
	|     TypeScript
	|
	+-- preview runner
	      preview kernel
	      preview app worker
```

App Code has no Worker API and no worker lifecycle code. It only calls the Devkit capability.

The shared Devkit host in `packages/app` stays neutral. It accepts `compile` and `typecheck`
functions. Frieren creates the real browser worker in `apps/frieren`, gives its client
functions to the shared Devkit host, and terminates the worker when the Frieren session ends.

Frieren creates one toolchain worker per client session, not one per project. The worker starts
on the first Devkit request. It stays alive so later builds can reuse esbuild, TypeScript, and
the standard type libraries. Frieren restarts it after a crash.

## Project format

Add an optional import map to the Devkit `project.json` file:

```json
{
	"id": "example.counter",
	"name": "Counter",
	"app": "src/app.ts",
	"gui": "src/gui.tsx",
	"imports": {
		"react": "https://esm.sh/react@19.1.1",
		"react-dom/client": "https://esm.sh/react-dom@19.1.1/client?bundle&deps=react@19.1.1"
	}
}
```

The source keeps normal bare imports:

```ts
import React from 'react'
import { createRoot } from 'react-dom/client'
```

Rules for the first release:

- Each value must be an HTTPS URL.
- The URL must contain an exact package version.
- Devkit rejects `latest`, version ranges, and unversioned package URLs.
- Existing projects without `imports` continue to work.
- The platform SDK remains a separate system import map.
- Project imports cannot replace platform SDK imports.

Devkit writes `devkit-lock.json` beside `project.json`. The lock records each final URL and its
content hash. Devkit owns this file. App Code does not resolve the dependency graph.

## Supported package model

The first release supports browser ESM packages that a CDN can bundle. React is the reference
framework.

It does not support:

- `npm install` or `node_modules`;
- `package.json` scripts;
- Node built-ins;
- native modules;
- post-install scripts;
- CommonJS-only packages;
- arbitrary Vite plug-ins;
- server-side packages;
- `.svelte` files.

Svelte needs its compiler and an esbuild loader for `.svelte` files. Add that only after the
React path works.

## Stage 1: prove the URL module format

Before changing the project contract, write a contained proof against the selected CDN. Use
`esm.sh` first.

The proof must fetch and inspect:

- `react`;
- `react-dom/client`;
- their type declaration entry points;
- one package with a transitive browser dependency;
- one unsupported Node package, to confirm the failure message.

Confirm these facts:

- Browser CORS permits every required request.
- The JavaScript response has stable versioned URLs.
- The response provides a TypeScript declaration URL.
- Relative and absolute imports in the returned JavaScript can be followed.
- Declaration imports can be followed without npm resolution.
- A cached response can build while the network is offline.

If `esm.sh` fails one of these checks, test a second CDN before adding any shared interface.
Keep all CDN-specific header and URL handling in one module.

Output: a Vitest fixture and a short decision note in this task file.

### Decision, 2026-08-23

Use `esm.sh` for the first adapter. Run the live probe with:

```sh
DEVKIT_CDN_PROBE=1 pnpm run test packages/app/capabilities/devkit/esm.probe.test.ts
```

The probe confirmed:

- JavaScript and declaration responses allow browser CORS.
- Versioned module responses use a one-year immutable cache policy.
- `X-TypeScript-Types` points to a declaration entry.
- Type ranges redirect to an exact versioned URL, which the lock must record.
- React DOM imports a pinned React URL, so the resolver can keep one React module in the graph.
- The downloaded JavaScript graph builds from memory after network access is disabled.

The probe also found two rules that the resolver must enforce:

1. Do not use `react@19.1.1?bundle`. React DOM imports `react.mjs`, while that entry imports
   `react.bundle.mjs`. The two React module instances break hooks. Use the normal React entry.
2. Do not trust CDN output as proof that a package supports the browser. `better-sqlite3`
   returns JavaScript with `/node/` shim imports and no type header. Reject any `/node/` import
   before the build.

The React entry points to `@types/react@~19.1.17`, but the React DOM declaration imports
`@types/react@19.2.14`. Stage 2 must lock every final declaration URL and detect two versions
of the same type package. Do not silently load both.

## Stage 2: add the import resolver

Add the resolver under `packages/app/capabilities/devkit/`.

The resolver receives the project's import map and returns three existing Devkit shapes:

- JavaScript modules for the runtime map;
- declaration files for `TypesBundle`;
- bare import mappings for `TypePaths`.

This keeps the current compiler backend signatures. The resolver merges project modules with
the installed platform sysroot before it calls `compile` or `typecheck`.

The resolver must:

1. Fetch each declared entry with `credentials: 'omit'`.
2. Follow HTTPS module imports and declaration imports.
3. Resolve relative URLs against the importing URL.
4. Reject an import that leaves the permitted HTTPS graph.
5. Hash every response body.
6. Write or verify `devkit-lock.json`.
7. Use a host-local cache on later builds.
8. Return structured Devkit diagnostics for expected failures.

Set hard limits for graph depth, file count, single-file size, total bytes, redirects, and
request time. Put the values beside the resolver and test each limit.

The cache is build data. Do not store it in the project source tree or sync it as user data.
Frieren supplies a browser cache. The Node development host supplies a disk cache. Keep that
host difference behind a small internal cache type.

### Implementation, 2026-08-23

`project.json` now accepts pinned `esm.sh` imports, and Devkit reads and writes
`devkit-lock.json` as project metadata. The resolver uses the `esm.sh` metadata endpoint for
package entry URLs. A shared URL store handles fetch, cache, limits, redirects, and hashes.
esbuild follows the JavaScript graph through its normal resolve and load hooks. TypeScript
finds declaration references with `preProcessFile`. The lock stores only redirects and remote
content hashes.

The resolver has fixed limits for graph depth, file count, file size, total bytes, Fetch's
20-redirect limit, and request time. Tests cover each limit, offline cache use, lock mismatch,
Node imports, final redirect URLs, and declaration loading. A live integration check built
React and React DOM, loaded six declaration files, passed type checking, and locked ten remote
responses.

Stage 3 will merge this output with the platform sysroot and pass it to the build and type-check
backends.

## Stage 3: use one resolved graph for build and type check

Update the esbuild virtual-file resolver so it handles:

- project source files;
- platform SDK imports;
- project import-map entries;
- relative and absolute imports inside downloaded ESM files.

Update the TypeScript host so it handles:

- platform SDK declarations;
- the TypeScript standard libraries;
- downloaded package declarations;
- the same bare import mappings used by the build.

Do not write separate package graph walkers. esbuild finds JavaScript imports, and TypeScript
finds declaration imports. Both tools use the same URL resolver, cache, limits, and lock.
Build, run, install, pack, and type check use that same resolver session.

Add React JSX support as an explicit project compiler setting. Do not make every `.tsx` file
assume React. The React template supplies the setting and imports required by its JSX mode.

Acceptance checks:

- Build and type check resolve the same React version.
- `react-dom/client` resolves as a declared subpath.
- A missing export produces a source diagnostic.
- Package declaration diagnostics do not appear as application source errors.
- Install and pack contain the dependency code.
- A packed app runs without network access.

## Stage 4: add the Frieren toolchain worker

Create a Frieren worker entry, for example
`apps/frieren/src/apps/devkit.toolchain.worker.ts`. It binds browser implementations to
`serveToolchain` from `packages/app/capabilities/devkit/toolchain.worker.ts`.

The worker owns:

- esbuild-wasm initialization;
- the TypeScript compiler;
- TypeScript standard library declarations;
- compile and type-check execution.

The Frieren Devkit adapter owns:

- worker creation;
- lazy startup;
- request correlation through `toolchainClient`;
- failure and restart handling;
- worker termination during Frieren teardown.

The generic `devkitCapability` does not call `new Worker`. It receives the worker-backed
`compile` and `typecheck` functions from Frieren. This keeps the shared host usable in Node,
Bun, and future hosts.

Move browser compilation into this worker when TypeScript is added. Do not keep esbuild on the
UI thread and create a second worker only for type checking.

Load the TypeScript compiler only on the first type-check request. A compile-only session pays
for esbuild-wasm but not TypeScript. Keep the worker alive after that first load.

Start with full `ts.createProgram` checks. Do not add incremental compiler state until the
performance fixture shows that repeat checks miss the target.

Performance targets for a medium React fixture:

- TypeScript is absent from Frieren's initial application bundle.
- Compilation and type checking create no long task on the UI thread.
- The first type check completes in less than 5 seconds on a development laptop.
- A repeat type check completes in less than 2 seconds.
- The worker uses less than 250 MB after a check.

Record the browser, machine, fixture size, download time, check time, and worker memory. Treat
these numbers as release checks, not assumptions.

## Stage 5: add the App Code flow

App Code remains a normal app. It does not import toolchain code and does not create a worker.

Changes in the App Code repository:

- Add `imports` and the JSX setting to its project metadata type.
- Add a React project template.
- Add a small import-map editor to project settings.
- Show fetch, lock, compile, and type errors in the existing Problems panel.
- Replace the text that says all external packages are unsupported.
- Keep the current `pnpm build --watch` local development command.

Do not add a terminal, an install command, automatic import discovery, or a package search UI
in this stage.

Acceptance flow:

1. Start App Code with `pnpm build --watch`.
2. Start Frieren with `VITE_FRIEREN_DEV_APP_STORE` set to the local store URL.
3. Create a React project in App Code.
4. Introduce and then fix a React type error.
5. Run the preview and edit it again.
6. Reload Frieren and build from the warm package cache.
7. Disable the network and build again.
8. Install the app and export its ZIP.
9. Run the installed and exported forms without CDN access.

## Stage 6: harden and release

Test the complete flow in Chromium, Firefox, and WebKit.

Cover these failures:

- a CDN timeout;
- a redirect loop;
- a changed body for a locked URL;
- a corrupt cache entry;
- a missing type declaration;
- an unsupported Node import;
- a toolchain worker crash;
- source changes while an older type-check request is running.

For stale checks, App Code or the Frieren adapter must discard results that do not match the
latest project revision. Do not add compiler cancellation in the first version.

Update `docs/app.md` after the behavior is stable. Document the exact package rules and show a
small React project.

Release the feature to App Code first. Do not make URL packages part of the general Devkit
contract until the React fixture completes one normal development cycle.

## Main repository files

| File | Change |
| --- | --- |
| `packages/app/capabilities/devkit/devkit.ts` | Read and validate the project import map and lock. |
| `packages/app/capabilities/devkit/toolchain.esbuild.ts` | Resolve downloaded ESM modules. |
| `packages/app/capabilities/devkit/toolchain.typescript.ts` | Load browser standard libraries and package declarations. |
| `packages/app/capabilities/devkit/toolchain.worker.ts` | Keep the shared worker protocol. Change it only if measurements require one-time initialization. |
| `packages/app/capabilities/devkit/host.ts` | Resolve each project's imports and merge them with its installed sysroot. |
| `apps/frieren/src/apps/devkit.client.ts` | Own the browser worker client and lifecycle. |
| `apps/frieren/src/apps/devkit.toolchain.worker.ts` | New worker entry with esbuild-wasm and TypeScript backends. |
| `apps/frieren/src/apps/capabilities.client.ts` | Give worker-backed functions to the Devkit capability. |
| `docs/app.md` | Document the supported browser package model. |

## Pull request order

1. Fix local-store enumeration and local version replacement.
2. Add the CDN proof, import-map project format, lock format, and resolver tests.
3. Add URL module resolution to build and type check.
4. Add the Frieren toolchain worker and browser performance fixture.
5. Update App Code with the React template and import-map settings.
6. Add browser failure tests and documentation.

Each pull request must leave existing SDK-only projects working. Do not merge a partial path
that makes `run`, `install`, and `pack` resolve packages differently.

## Estimate

For one developer:

- URL imports, cache, lock, React build, and React type checking: 3 to 5 weeks.
- Svelte compiler support after that: 1 to 2 more weeks.
- General npm and Vite compatibility: outside this plan. It needs a different execution model,
  most likely a remote container.

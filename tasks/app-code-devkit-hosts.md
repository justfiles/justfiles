---
project: packages/app-code
status: in-progress
---

# app-code: restore devkit support across app hosts

## Problem

App Code needs the `devkit` capability to compile, type-check, run, stop, package,
and install an app.

The generic Vite app host registers only `volume`. App Code starts and can create a
project, but Run and Install cannot complete. Run also hides the capability error and
changes the button to Stop, although no preview exists.

Mac and Frieren already use the shared `devkitCapability` factory. They use different
toolchains and runners, so behavior can drift. Standalone Runner does not provide a
development host. It only provides app assets and a browser runtime with `volume`.

## Goal

Restore the complete App Code workflow in this order:

1. Vite host;
2. Mac;
3. Frieren.

Use one shared devkit flow. Each host supplies only the compiler, type checker,
sandbox, and runner that its environment supports.

The final workflow must support:

- create and edit a project;
- compile and package it;
- run and stop a preview;
- install it into the host kernel;
- show a useful error when a host operation fails.

## Design decisions

### Keep one devkit core

Use the existing `devkitCapability` factory for all hosts. Do not add a Vite-only
devkit implementation. Do not add a new public interface unless a second real user
requires it.

The expected host support is:

| Host | Compiler | Type checker | Preview |
| --- | --- | --- | --- |
| Vite | native esbuild | TypeScript | local URL |
| Mac | `Bun.build` | TypeScript | Mac app URL or window |
| Frieren | `esbuild-wasm` | unavailable | Frieren app window |

Type checking is an optional host function. Frieren does not need a browser TypeScript
compiler to pass this task.

### Keep the Vite sandbox split small

The Vite host must continue to run the app under development through Vite HMR. A
generated app must run from its compiled reducer, not from the App Code source module.

Use two sandbox paths:

- use the current Vite HMR sandbox for App Code;
- use the standard Node worker sandbox for generated preview apps.

Select the path by the app ID. Do not create a general sandbox registry.

### Make the sysroot available to App Code

App Code packages the devkit sysroot under `devkit/**`. The Vite development install
must include these files. Use the existing app asset include rule. Do not add a second
sysroot format.

### Keep Runner separate

`apps/runner` can deliver App Code assets, but it is not automatically a development
host. It has no local compiler, preview runner, or install destination.

Do not add devkit to standalone Runner in this task. Make that a separate product
decision after Vite, Mac, and Frieren pass the same workflow.

## Implementation

### 1. Add a failing Vite workflow test

Start with one Vite-host test that installs App Code and proves the current failure.
Use a small generated app with a DOM GUI and a reducer. Do not use React or another
framework.

The test must cover these actions:

1. create or load the generated app project;
2. run it;
3. receive a preview URL;
4. dispatch one action and observe the new state;
5. stop the preview;
6. install the app and read its installed manifest, reducer, and GUI.

Keep the assertions local to the Vite test. Extract shared assertions only when Mac
becomes the second test user.

### 2. Add devkit to the Vite host

Pass these adapters to the existing devkit factory:

- native esbuild compilation;
- TypeScript type checking;
- the generated-app Node worker sandbox;
- a local preview runner.

The local preview runner must:

- return `kind: 'url'` so App Code can use its preview pane;
- serve the compiled GUI for the preview app;
- send actions to the preview kernel;
- send state changes back to the GUI;
- release its preview state when Stop is called.

Install must write the local bundle to the same in-memory kernel. A local app has no
`baseUrl`, so its manifest, reducer, GUI, and other bundle files stay under
`/applications/<id>`.

Do not add persistence, a launcher, or a second app catalog to the Vite host.

### 3. Fix App Code failure state

Remove the empty Run error handler. Change the UI to Stop only after Run returns a
valid preview. If Run, Stop, or Install fails, show the error and keep the controls in
the correct state.

Keep error presentation inside App Code UI code. Do not change the devkit interface
only to report an error that a rejected operation already contains.

### 4. Verify Mac

Run the same workflow against the Mac devkit adapters. Reuse only the workflow
assertions that are now common to two hosts.

Mac remains the full native implementation:

- compile with `Bun.build`;
- type-check with TypeScript;
- run through the existing Mac runner;
- install a complete local bundle.

Fix only behavior that differs from the shared workflow. Do not replace working Mac
adapters with Vite adapters.

### 5. Verify Frieren

Run the reduced workflow against Frieren:

- compile with `esbuild-wasm`;
- skip type checking when the host does not provide it;
- run through the Frieren window runner;
- install a complete local bundle;
- read `devkit/**` through the current asset cache and mount rules.

Do not add native-only functions to the browser host. A missing optional type checker
must not stop compile, run, package, or install.

### 6. Review standalone Runner later

After all three development hosts pass, decide whether standalone Runner must support
local app development.

If it must, create a separate task that defines:

- where compilation runs;
- where generated projects and installed apps persist;
- how preview windows or URLs work;
- which security limits apply to third-party code.

### 7. Reduce the sysroot last

Do this only after Vite, Mac, and Frieren pass the shared workflow. Keep one sysroot
format and one Code release for all hosts.

First record the built size and file count as a regression baseline. The current build
has 1.34 MiB of raw data in 234 files. Types use about 1.09 MiB, and runtime modules use
about 229 KiB.

Make these reductions in order:

1. Replace the `type-fest` `TsConfigJson` dependency with the smallest local type that
   describes the generated configuration. Do not copy a general TypeScript schema.
2. Minify the SDK runtime modules before writing them to the content-addressed store.
3. Measure again. Stop if the result is near 0.75 MiB and all host tests pass.

Keep Valibot in the authoring SDK. Do not add compression to the Volume, a host-specific
sysroot, or optional sysroot file rules unless a later measurement proves they are
necessary.

The sysroot is a Code release asset, not user data. A hosted Code install must keep only
its manifest and reducer under `/applications/justfiles.code`; the GUI, icon, and
`devkit/**` files must use the host asset cache. On Mac, this cache move requires an
immutable Code release with a `baseUrl` and hashes. Until that release exists, the
packaged local Code bundle has no recovery source, so keeping its full bundle under
`/applications/justfiles.code` is correct.

## Verification

Use Vitest for new automated tests. Use pnpm scripts and Node for local commands.

Run, at minimum:

- the focused Vite devkit workflow test;
- existing `packages/app-code` tests;
- existing shared devkit and sandbox tests;
- the Mac devkit workflow test;
- Frieren tests for compile, run, stop, install, and mounted sysroot reads;
- type checks for every changed package.

Also run one manual App Code check in each host:

1. create the plain DOM starter;
2. select Run and confirm that the preview opens;
3. change project code and run it again;
4. select Stop and confirm that the preview closes;
5. select Install and confirm that the installed app can start.

## Done when

- Vite Run opens a working preview and Stop closes it.
- Vite Install writes and can start the generated app.
- App Code shows host errors and never displays a false running state.
- Mac passes the full shared workflow, including type checking.
- Frieren passes the reduced workflow without a TypeScript compiler.
- All three hosts use the existing shared devkit core.
- Standalone Runner behavior does not change.
- The final sysroot reduction keeps one cross-host format and passes the size regression
  check.

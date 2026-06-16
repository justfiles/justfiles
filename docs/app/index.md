---
title: '@justfiles/app'
description: App runtime, SDK, kernel, sandbox, and capabilities.
---

# `@justfiles/app`

Source: `packages/app`

`@justfiles/app` is the app runtime package. Hosts use it to install app bundles, run reducers in a sandbox, persist app state, and expose host capabilities through a trusted boundary.

## Mental model

- Apps are bundles installed into a `@justfiles/fs` `Volume`.
- The `kernel` owns app install/uninstall, dispatch, state, actions, subscriptions, and app asset reads.
- A host supplies three things: a `Volume`, a sandbox loader, and optional capabilities.
- `defineApp()` describes an app as a small state machine: initial state, public edges, commands, subscriptions, and procedures.
- Capabilities are declared by the app but resolved by the kernel, so the sandbox cannot grant itself extra scopes.

## Key files

- `packages/app/index.ts` — public exports.
- `packages/app/kernel.ts` — runtime kernel.
- `packages/app/sdk.ts` — `defineApp()` and typed client API.
- `packages/app/app.ts` — app bundle and manifest types.
- `packages/app/capabilities/` — capability contracts and hosts.
- `packages/app/devkit.ts` — development/install tooling.

## Commands

```sh
pnpm --filter @justfiles/app typecheck
```

## TODO

- Document the app bundle layout under `/applications/<id>`.
- Add a minimal `defineApp()` example.
- Document each built-in capability contract.

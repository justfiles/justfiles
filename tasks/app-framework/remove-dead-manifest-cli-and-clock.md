---
project: packages/app
status: todo
---

# Remove the unused `cli` manifest entry and the empty `clock` seam

## TL;DR

Every bundle carries a `cli` entry and an empty `cli.js`, yet nothing in any host or in the agent
runtime executes it. The kernel takes a `clock` whose type is `object` and every host passes `{}`.
Both are promises the framework does not keep. Remove them.

## Proposed change

Breaking, SDK and kernel:

```ts
// app.ts
interface AppManifest { id; name; description?; version?; icon?; app; gui?; include?; capabilities?; baseUrl?; hash?; files? }
// removed: cli
interface MemoryAppBundle { ... }    // removed: cli; appBundleFromMemory no longer writes cli.js

// kernel.ts
interface System { fs; sandbox; fetchAsset?; capabilities? }   // removed: clock
// removed: type Clock
```

Also drop `cli` from `appstore.fs.ts`'s required-entries list and from `appstore.protocol.ts`.
Reading a manifest that still contains `cli` stays tolerant: unknown fields are ignored.

## Why

- **A manifest field is a contract.** An author reading `cli?: string` will ask what to put there
  and what runs it. The honest answer today is nothing. Fields that exist "for later" cost a
  question per author and a line per store.
- **The text interface already exists.** The agent drives apps through actions and procedures via
  the `app` command. A per-app CLI entry would be a second text interface to the same state machine,
  which is the opposite of the one-model, two-consumers design.
- **An empty seam is worse than no seam.** `clock: {}` suggests the kernel is time-injectable for
  tests. It is not. Either make the seam real when a test needs it, or remove it so nobody relies
  on it.

---
project: packages/app
status: todo
---

# Split the author SDK from the host runtime

## TL;DR

`@justfiles/app` exports about forty subpaths. Six of them are what an app author uses; the rest
are kernel, sandbox, iframe host, app store, devkit toolchains, account providers, and dev-server
internals. The docs already forbid apps from importing them. Move the host half into its own
package so the author package's export map is its API.

## Proposed change

Breaking for hosts and the dev tooling, not for apps.

```text
@justfiles/app            (author SDK)
  .                        defineApp, Client, createClient, Transport, types
  ./browser                defineGUI, injectStyle
  ./react                  defineReactGUI
  ./capabilities           core types, defineCapability
  ./capabilities/<id>      contracts only (volume, ai, notify, email, calendar, reader, image, devkit)
  ./vite                   kernelHost, devAi

@justfiles/kernel         (host runtime; name open)
  ./kernel  ./sandbox  ./iframe  ./dev-server  ./appstore  ./appstore/fs  ./appstore/protocol
  ./toolchain/*  ./devkit-runtime  ./runtime-specs  ./image-type  ./accounts/*
  ./capabilities/<id>/host  ./capabilities/ai/dev  ./capabilities/ai/node
  createAppController, sweepTrash, bundleFromZip
```

The root `index.ts` of the author package stops re-exporting `kernel`, `createAppController`,
`sweepTrash`, and `bundleFromZip`. `@justfiles/app/vite` keeps importing the dev server from the
host package, so an app's `vite.config.ts` does not change.

Dependencies follow the code: `capnweb`, `fflate`, `es-module-lexer`, `pi-agent-core`, `pi-ai`,
and `typebox` move to the host package.

## Why

- **An export map is documentation.** An agent or a person learning the SDK reads `package.json`
  and the `.d.ts` files. When most of what they find is explicitly off-limits, the first lesson is
  "you have to know which parts to ignore", which the docs then have to teach.
- **Versioning follows the audience.** Today a change to the Durable Object sandbox or the devkit
  toolchain bumps the package every app depends on. Separating the two lets the author surface
  stay still while the host moves, which directly lowers the breaking-change cadence that caused
  the public apps to fall behind.
- **Dependency hygiene.** An app SDK that transitively installs an RPC library, a zip
  implementation, and an agent harness is heavier than it needs to be and widens the surface a
  publisher ships.
- **The boundary already exists in prose.** `docs/app.md` draws exactly this line. Making the
  package reflect it removes a rule that currently has to be remembered.

---
title: Quay
description: Native macOS launcher and local daemon.
---

# Quay

Source: `apps/quay`

Quay is the native macOS host. It projects Ghostore apps into the operating system while a local daemon runs the trusted app kernel, filesystem, capabilities, and agent.

## Architecture

- The native launcher starts or reconnects to `quayd`.
- `quayd` mounts a native `@justfiles/fs` volume under the user's application-support directory.
- The host builds a `@justfiles/app` kernel over that volume and seeds built-in apps.
- A localhost HTTP server serves app shells, `gui.js`, vendor assets, and design CSS.
- WebSocket endpoints serve the launcher catalog, agent chat, and per-app Cap'n Web berths.
- App windows pin reducer workers while open and release them when closed.
- Installed apps are projected as real macOS `.app` bundles; the volume remains the source of truth.

## Key files

- `apps/quay/quayd/main.ts` — daemon entry point.
- `apps/quay/quayd/host.ts` — trusted host: volume, kernel, capabilities, accounts, sandbox.
- `apps/quay/quayd/server.ts` — localhost HTTP/WebSocket server.
- `apps/quay/quayd/berth.ts` — app GUI transport.
- `apps/quay/quayd/materialize.ts` — macOS app projection.
- `apps/quay/native/` — native macOS code.
- `apps/quay/launcher-ui/` — launcher UI.

## Commands

```sh
pnpm --filter @justfiles/quay quayd
pnpm --filter @justfiles/quay build
pnpm --filter @justfiles/quay restart
```

## TODO

- Document launch/reconnect lifecycle.
- Document the runtime file locations.
- Explain the launcher socket protocol and berth protocol.

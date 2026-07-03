---
title: Quay
description: Native macOS launcher and local daemon.
---

# Quay

Source: `apps/quay`

Quay is the native macOS host. It projects Ghostore apps into the operating system while a local daemon (`apps/quay/daemon`) runs the trusted app kernel, filesystem, capabilities, and agent.

## Architecture

- The native launcher starts or reconnects to the daemon (discovered via `runtime.json`).
- The daemon mounts a native `@justfiles/fs` volume under the user's application-support directory.
- It builds a `@justfiles/app` kernel over that volume and seeds built-in apps.
- A localhost `Bun.serve` HTTP server serves the Vite-built browser surfaces (launcher, chat, app shell), each app's `gui.js`, and its icon.
- Plain WebSocket endpoints serve the launcher catalog + slash-command menu + notifications (`/system`), the shared agent chat session (`/agent`), and per-app state/dispatch (`/app/:id/connect`).
- App windows pin reducer workers while open and release them when closed.
- Installed apps are projected as real macOS `.app` bundles; the volume remains the source of truth.

## Key files

- `apps/quay/daemon/main.ts` — daemon entry point + the `Bun.serve` HTTP/WebSocket server (`createServer`).
- `apps/quay/daemon/kernel.ts` — trusted kernel wiring: volume, capabilities, accounts, sandbox, devkit.
- `apps/quay/daemon/agent.ts` — the shared agent session, slash-command dispatch, and app-control bridge.
- `apps/quay/daemon/protocol.ts` — the WebSocket wire protocol types.
- `apps/quay/daemon/materialize.ts` — macOS app projection.
- `apps/quay/native/` — native macOS code.
- `apps/quay/ui/` — the Vite-built launcher / chat / app-shell surfaces.

## Commands

```sh
pnpm --filter @justfiles/quay dev
pnpm --filter @justfiles/quay build
pnpm --filter @justfiles/quay install:app
```

## TODO

- Document launch/reconnect lifecycle.
- Document the runtime file locations.
- Explain the launcher socket protocol and berth protocol.

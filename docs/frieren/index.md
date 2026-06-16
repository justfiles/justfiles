---
title: Frieren
description: Web/cloud desktop, user profiles, sync, apps, and agent runtime.
---

# Frieren

Source: `apps/frieren`

Frieren is the web/cloud host. It runs the desktop UI in the browser and uses a Cloudflare Worker/Durable Object backend for authenticated storage, app runtime, accounts, and the agent.

## Architecture

- The React client boots a desktop shell with windows, menubar, dock, app viewport, and agent sidebar.
- Local browser profiles use IndexedDB-backed `@justfiles/fs` storage.
- Clerk auth is optional for local use; signed-in profiles attach to a remote user and sync.
- The Worker authenticates API and WebSocket routes, then forwards each user to their Durable Object.
- The Durable Object owns the user's remote volume, app kernel, accounts store, and agent runtime.
- Built-in and installed apps run through the same `@justfiles/app` model as Quay.

## Key files

- `apps/frieren/src/App.tsx` — boot, auth, profile, and onboarding flow.
- `apps/frieren/src/fs.ts` — local profiles and local-first sync.
- `apps/frieren/src/shell/DesktopShell.tsx` — desktop chrome.
- `apps/frieren/src/apps/` — app catalog, host, sandbox, and viewport.
- `apps/frieren/src/os/` — window manager state.
- `apps/frieren/worker/index.ts` — Worker routes and auth forwarding.
- `apps/frieren/worker/frieren.ts` — per-user Durable Object runtime.

## Commands

```sh
pnpm --filter frieren dev
pnpm --filter frieren build
pnpm --filter frieren verify:ui
```

## TODO

- Document profile switching and sync states.
- Document the app install path and GUI asset routes.
- Document local dev setup for Clerk, Cloudflare, and LLM credentials.

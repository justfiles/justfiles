# Filesystem Layout Redesign

## Context

The Frieren DO owns one root volume backed by `cfFsStorage`. Today it is wrapped twice before any app sees it:

1. `frieren.ts:167` passes `chroot(this.vol, '/kernel')` into `frierenApps`, so every kernel-managed path is silently prefixed with `/kernel`.
2. `volume.capability.ts` resolves the app-declared `'system'` scope to that already-chrooted volume, so an app asking for "the root" actually sees `/kernel`.

The Finder app (`scopes: ['system']`) is the visible symptom: from its perspective the root only contains `/applications/...`, while the real volume root also holds `/soul.md`, `/MEMORY.md`, `/profiles/`, `/memory/`, `/agents/`, `/kernel/`.

Additional structural problem: the kernel persists state at `${appRoot}/data/state.json`, mixing kernel-owned state with the app's own data sandbox. We want the app's `data/` to be purely "stuff the app authored", with state in a separate tree.

## Final layout

All lowercase. No hidden dotdirs. Four top-level trees.

```
/
├── applications/<id>/        ← bundle (manifest.json, app.js, gui.js, icon, …)
├── state/<id>.json           ← kernel-persisted reducer state
├── data/<id>/                ← per-app sandbox (default 'app' volume scope)
└── system/                   ← Frieren-OS internals
    ├── soul.md
    ├── MEMORY.md
    ├── profiles/user.md
    ├── memory/daily/<YYYY-MM-DD>.md
    └── agents/<agentId>/sessions/{sessions.json, <sid>.jsonl}
```

### Volume capability scopes

| Scope             | Binds to                  | Notes                                                       |
| ----------------- | ------------------------- | ----------------------------------------------------------- |
| (none) / `'app'`  | `chroot(/data/<id>)`      | Default. App cannot see its own state.                       |
| `'system'`        | root volume               | Allowlisted to specific app IDs (Finder first; later more).  |
| `/some/prefix`    | `chroot(/some/prefix)`    | Escape hatch; still resolves against root, not `/kernel`.    |

`/system/` is a real chroot boundary: only `'system'`-scoped apps see it. A `/system/...` prefix scope is rejected unless the app also holds `'system'`.

`config/` and `cache/` are intentionally not in the layout. Add them the day they're needed.

## Steps

Each step compiles, passes tests, and is observable on its own. After every step: `pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test`.

### Step 1 — Move kernel state to `/state/<id>.json`

**Files:** `packages/app/kernel.ts`

- `loadState` takes `appId` instead of `root`, reads `/state/<appId>.json`.
- `dispatch`: drop the `mkdir(${root}/data)`; `mkdir('/state', { recursive: true })` once before write; `statePath = /state/${appId}.json`.
- `state(appId)`: read from `/state/<appId>.json`.
- `uninstall(appId)`: also `fs.rm('/state/<id>.json', { force: true })` and `fs.rm('/data/<id>', { recursive: true, force: true })`.

**Verify:** update `packages/app/kernel.test.ts` to assert state persists at `/state/<id>.json` (not under the app root) and that uninstall removes state + data. `pnpm --filter @justfiles/app test` green.

### Step 2 — Drop the `/kernel` chroot in the DO

**Files:** `apps/frieren/worker/frieren.ts`

- Line 167: pass `this.vol` directly into `frierenApps` (delete the `chroot(this.vol, '/kernel')` wrap).

**Verify:** start `pnpm dev` in `apps/frieren/`, nuke (`POST /api/nuke`), trigger any built-in install. Inspect via the `/fs` API: `/applications/<id>/manifest.json` exists at the root, no `/kernel/` directory.

### Step 3 — Default `'app'` scope binds to `/data/<id>`

**Files:** `apps/frieren/worker/volume.capability.ts`, `apps/frieren/worker/volume.capability.test.ts`

- `resolveVolume`: default branch returns `chroot(fs, /data/${appId})` (was `/applications/${appId}/data/files`).
- Update test expectations.

**Verify:** test green. Open paint via Finder, draw something, check the bytes land at `/data/app.frieren.paint/...` not under `/applications/...`.

### Step 4 — Allowlist `'system'` scope; reject system-prefix without it

**Files:** `apps/frieren/worker/volume.capability.ts`, `apps/frieren/worker/volume.capability.test.ts`

- Add `const SYSTEM_SCOPE_ALLOWLIST = new Set(['app.frieren.finder'])`.
- `resolveVolume({ appId, scopes })`: if `scopes` includes `'system'` and `appId ∉ allowlist`, throw `CAPABILITY_UNAVAILABLE`.
- If `scopes` includes a `/system` or `/system/...` prefix and the app doesn't hold `'system'`, throw `CAPABILITY_UNAVAILABLE`.

**Verify:** test cases — Finder with `'system'` succeeds; a fake app with `'system'` throws; an app with `'/system/profiles'` throws.

### Step 5 — Move OS-internal paths under `/system/`

**Files:** `apps/frieren/worker/frieren.runtime.ts`, `apps/frieren/worker/timezone.ts`, `apps/frieren/worker/frieren.ts`

- `frieren.runtime.ts` PATHS table:
  - `soul: '/system/soul.md'`
  - `profile: '/system/profiles/user.md'`
  - `memory: '/system/MEMORY.md'`
  - `daily: (d) => '/system/memory/daily/<YYYY-MM-DD>.md'`
  - `sessions: (id) => '/system/agents/<id>/sessions/sessions.json'`
  - `sessionFile: (id, sid) => '/system/agents/<id>/sessions/<sid>.jsonl'`
- `timezone.ts:5`: `/system/profiles/user.md`.
- `frieren.ts:406-407`: `/system/profiles/user.md`, `/system/soul.md`.

**Verify:** `pnpm test` green. Nuke + onboard a fresh user via the UI: soul, MEMORY, profile land under `/system/`; chat one round and confirm session jsonl lands under `/system/agents/<id>/sessions/`.

### Step 6 — End-to-end Finder check

**Files:** none.

- `pnpm dev`, `pnpm run verify:ui`, open Finder.
- Confirm Finder root lists entries from all four trees: `/applications/<id>` (bundles), `/state/<id>.json` (per dispatched app), `/data/<id>/` (per app that wrote), `/system/...` (OS internals).
- Confirm a non-Finder app cannot read `/system/...` or claim `'system'`.

### Step 7 (optional, do later) — Mirror in dev-server

**Files:** `packages/app/dev-server.ts`

`invokeVolume` mirrors the production path resolver. Once the prod layout is stable, sync dev-server so per-package `pnpm dev` matches: default scope → `/data/<id>`, no `/kernel` wrap. Skip the system allowlist (dev-server is single-app, in-memory).

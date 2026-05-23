# @justfiles/app

Platform-agnostic contract for the app system. Defines how a third-party app inside an iframe talks to a host server through a browser shell. No transport, no persistence — only types and helpers.

## Three parties, four contracts

```
┌─────────────────────────────────────────────────────────┐
│  SERVER                                                 │
│       AppHost                                           │
│       │  current / launch / close                       │
│       │  dispatch(AppRpcRequest) → AppRpcResponse       │
└────────────────────────▲────────────────────────────────┘
                         │   transport (WebSocket, …)
                         │   carries JSON-RPC frames
┌────────────────────────▼────────────────────────────────┐
│  BROWSER SHELL                                          │
│    AppLauncher                AppRelay                  │
│    │ activeApp                │ sendRpc                 │
│    │ installedApps            │ onToolInvoke            │
│    │ launch                   │ sendToolResult          │
│    └ close                    └ notifyIframeReload      │
│         ▲                          ▲                    │
│         │ chat view                │ iframe chrome      │
└────────────────────────────────────▲────────────────────┘
                                     │   postMessage
                                     │   carries JSON-RPC frames
┌────────────────────────────────────▼────────────────────┐
│  IFRAME                                                 │
│       window.app : App                                  │
│       │  volume, capabilities, agent, tools, lifecycle  │
└─────────────────────────────────────────────────────────┘
```

| Contract | Side | Role | Consumer |
|---|---|---|---|
| `App` | iframe (`window.app`) | Author-facing SDK | App code |
| `AppRelay` | browser shell | Forwards RPC frames iframe ⇄ server; routes server-initiated tool calls | Iframe chrome (e.g. `AppFrame`) |
| `AppLauncher` | browser shell | Holds `activeApp` + `installedApps`; `launch()` / `close()` | Chat view that shows a launcher |
| `AppHost` | server | Source of truth: dispatch, permissions, capabilities, tools, lifecycle | Server worker; tests mock the interface |

Naming rule: **Host hosts. Launcher launches. Relay relays. App is the app.**

## Single source of truth

All wire shapes live in [`protocol.ts`](./protocol.ts). Adding a method is a one-line edit; downstream signatures derive from these registries.

| Registry | Direction | Drives |
|---|---|---|
| `AppRpcRegistry` | iframe → server | `App` SDK methods, `AppHost.dispatch` signature, `AppRelay.sendRpc` signature |
| `AppHostRpcRegistry` | server → iframe | `AppRelay.onToolInvoke` / `sendToolResult` parameter types |
| `AppCapabilityMap` | broker contract | `app.capabilities.*` typed access; extensible by interface declaration merging |

Stable error codes ship as `APP_RPC_ERROR`. Manifest-permission gating ships as `APP_RPC_PERMISSION`.

## Subpath exports

- `@justfiles/app` — interfaces, registries, manifest schema. **No transport.**
- `@justfiles/app/sdk` — the iframe `window.app` SDK (bundled to a classic-script IIFE).
- `@justfiles/app/vite` — `hostApps()` plugin that emits the per-app manifest registry virtual module.
- `@justfiles/app/virtual` — type ambient for `virtual:@justfiles/apps`.
- `@justfiles/app/format` — manifest schema standalone.
- `@justfiles/app/kernel/capabilities`, `@justfiles/app/kernel/capabilities/{broker,email,calendar,volume}` — capability contracts and the host-side broker interface.

## Surface discipline

The public surface is guarded by [`surface.test.ts`](./surface.test.ts), which snapshots `Object.keys` of `index.ts` against an explicit allowlist. Update the allowlist intentionally when adding a contract — never to silence a failing test.

Before exporting anything, ask:

- Is this a **contract** or an **implementation**? Only contracts and platform-level data types belong here.
- Could this **leak** how a downstream module is built? (Loose unions, internal message shapes, transport adapters, persisted-storage shapes do not belong here.)
- Is there a **derived form**? If a type can be derived from `AppRpcRegistry` / `AppHostRpcRegistry`, derive it.
- Is the name **role-bearing**? Avoid `client`, `bridge`, `manager`. Prefer `Host`, `Launcher`, `Relay`.

## Testing

```sh
bun run typecheck
bun test
```

Type-level drift between the registries and the contracts is covered by [`host.test.ts`](./host.test.ts) and [`client.test.ts`](./client.test.ts). Adding a method to a registry without updating the corresponding contract is caught at compile time.

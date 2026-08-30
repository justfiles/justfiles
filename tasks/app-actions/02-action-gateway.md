---
status: todo
depends_on: design
milestone: 1
---

# T2: Add the generic action gateway

## Result

An authenticated HTTP client can list the user's installed apps, inspect one
app's agent-visible actions, and run one action through the existing Frieren
`AppController`.

This task does not know about Chrome or Read. It may be implemented in parallel
with T1.

## Routes

Implement the contract from [the design](00-design.md):

```text
GET  /api/v1/apps
GET  /api/v1/apps/:appId
POST /api/v1/apps/:appId/actions/:action
```

The public Frieren Worker authenticates the existing Clerk `session_token`,
derives the Clerk user ID, and forwards to that user's Durable Object exactly as
other `/api/*` routes do today. The Durable Object handles these three paths and
calls `this.getApps().controller`.

Do not add a Read route, a new Durable Object, or a second controller.

## Execution

For a run request:

1. Require `Content-Type: application/json` and a body no larger than 1 MiB.
2. Decode one `appId` path segment and one `action` path segment. Reject invalid
   percent encoding or empty values.
3. Require the decoded JSON value to be an object. That object is the action's
   params; do not wrap it again.
4. Inspect the app through `AppController.inspect(appId)`.
5. Require `inspection.actions[action]` to exist. This keeps GUI-only procedures
   off the external surface without adding an `external` flag.
6. Call `AppController.run(appId, action, params)` once.
7. Return `200 { "result": ... }`.

List returns `AppSummary[]`. Inspect returns the existing `AppInspection`,
including current state and action metadata. Avoid reshaping these models until
a real compatibility problem appears.

## Error boundary

Add one small mapper local to the route adapter. It must distinguish:

- missing app → `404 app_not_installed`;
- missing/non-visible action → `404 action_not_found`;
- Standard Schema parameter rejection → `400 invalid_params`;
- transport/body rejection → `400 invalid_request`; and
- other execution failure → `500 action_failed`.

Existing lower layers throw plain errors, so match only stable error prefixes
already produced by the kernel (`app not found`, `invalid params`, `unknown
procedure`). Everything else stays an internal failure. Do not build a new
cross-package error hierarchy for three routes.

Log route, status, app ID, action name, and a request correlation ID. Never log
the Authorization header, params, action result, or full thrown object; app
inputs and state may contain private user data.

## Likely files

- `platform/frieren/worker/frieren.ts`: Durable Object routes and controller
  adapter.
- `platform/frieren/worker/index.ts`: only if the existing `/api/*` forwarding
  does not already cover the new routes.
- A focused route/helper test beside the worker code.

Do not change `packages/app` unless a failing test proves the controller lacks
something required by this contract.

## Tests

At minimum prove:

- no bearer token returns 401 before reaching the Durable Object;
- a valid session token selects its own user Durable Object;
- list filters preview apps as `AppController` already does;
- inspect omits a `gui`-only procedure;
- run calls the requested controller action once and returns its result;
- an object with nested arrays/objects reaches the controller unchanged;
- bad JSON, non-object JSON, wrong content type, and an oversized body return
  `invalid_request`;
- an absent app returns `app_not_installed`;
- an absent or GUI-only action returns `action_not_found`;
- app schema failure returns `invalid_params` without a stack trace; and
- unexpected procedure failure returns `action_failed` without leaking the
  params or internal error.

Add one integration test using the real Read bundle when practical:

```json
{
	"appId": "justfiles.read",
	"action": "save",
	"params": { "input": "https://example.com" }
}
```

Mock the reader capability; the test must not call the public internet.

## Acceptance

With a valid Clerk session token, this request invokes the existing Read action
on the authenticated user's server kernel:

```sh
curl -X POST "$FRIEREN_ORIGIN/api/v1/apps/justfiles.read/actions/save" \
  -H "Authorization: Bearer $JUSTCOMPUTER_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"input":"https://example.com/article"}'
```

The same route works for another installed app and action without gateway code
changes.

## Non-goals

- API-key authentication; that is T5.
- CORS middleware. A Chrome extension service worker uses explicit manifest
  host permissions. Add CORS only if a browser test demonstrates a need.
- App/action scopes, `external` metadata, grants, or consent prompts.
- Jobs, webhooks, streaming, batch execution, or idempotency keys.
- Installing missing apps on the server.

# Design: one action surface, several adapters

This is the shared contract for [the work plan](README.md). It records the
decisions that implementation tasks should not reopen.

## Current seams to reuse

- [`packages/app/app-controller.ts`](../../packages/app/app-controller.ts)
  already provides `list`, `inspect`, `state`, and `run` over a kernel.
- [`platform/frieren/worker/frieren.app.ts`](../../platform/frieren/worker/frieren.app.ts)
  already constructs that controller over the user's server-side kernel.
- [`platform/frieren/worker/index.ts`](../../platform/frieren/worker/index.ts)
  already authenticates `/api/*` with Clerk and routes the request to the
  Durable Object named by the Clerk user ID.
- [Read's `src/app.ts`](https://github.com/justfiles/app-read/blob/main/src/app.ts) already exposes a `save`
  procedure with `{ input: string }`; no Read-only endpoint is needed.
- [`packages/agent/justbash/app.ts`](../../packages/agent/justbash/app.ts) proves
  the useful generic interaction: list apps, inspect actions, then run one.

The missing piece is only an HTTP adapter around the existing controller.

## HTTP contract

Version the transport, not app actions:

```http
GET /api/v1/apps
Authorization: Bearer <credential>

GET /api/v1/apps/{appId}
Authorization: Bearer <credential>

POST /api/v1/apps/{appId}/actions/{action}
Authorization: Bearer <credential>
Content-Type: application/json

{"input":"https://example.com/article"}
```

The first call is exactly:

```http
POST /api/v1/apps/justfiles.read/actions/save

{"input":"https://example.com/article"}
```

Responses use one small, stable shape:

```json
{ "result": "the value returned by AppController.run" }
```

Errors use HTTP status plus a machine-readable code:

```json
{
	"error": {
		"code": "invalid_params",
		"message": "invalid params for save: input is required"
	}
}
```

Required mappings:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Bad JSON, wrong content type, oversized body, or malformed path |
| 400 | `invalid_params` | The app rejected the action parameters |
| 401 | `unauthorized` | No valid supported credential |
| 404 | `app_not_installed` | The account's server volume has no such app bundle |
| 404 | `action_not_found` | The action is not on the app's agent-visible surface |
| 500 | `action_failed` | The action failed without a safer public classification |

Do not expose stack traces, Clerk details, capability secrets, or raw internal
error objects. Preserve enough of a schema-validation message to let a human or
agent repair its request.

## Authorization model

Authentication selects one Clerk user and therefore one Frieren Durable Object.
Inside that account, the credential can list, inspect, and run every action
returned by `AppController.inspect()`.

There is intentionally no additional authorization model yet:

- no action `external` property;
- no scopes or grants;
- no credential-to-app mapping;
- no confirmation framework; and
- no separate external-action registry.

The gateway must check that the requested action appears in the inspected
`actions` map before calling `run`. This preserves the existing meaning of
`audience: 'gui'` without inventing a new external flag.

The full-control decision is a milestone assumption, not a claim that every
future third-party integration should receive total access. Revisit it only
when there is a real second trust tier.

## Client model

Every adapter implements the same three operations:

```ts
interface AppActionsClient {
	list(): Promise<AppSummary[]>
	inspect(appId: string): Promise<AppInspection>
	run(appId: string, action: string, params: unknown): Promise<unknown>
}
```

Do not create a shared package for this interface in Milestone 1. Keep the
three fetch functions inside the extension. Promote them only when T5 creates a
second real consumer.

The extension's first feature is deliberately thin:

```ts
client.run('justfiles.read', 'save', { input: activeTab.url })
```

Read owns URL normalisation, fetching, duplicate detection, and persistence.
The extension owns only user gesture, authentication, transport, and status.

## Operational properties

- Actions run synchronously for now. The HTTP request stays open until the
  existing procedure returns. Do not add a job system for the Read POC.
- At-least-once retries are possible. Actions should define their own
  idempotency semantics; Read already deduplicates by normalised URL.
- The gateway does not launch the app UI. Running an action is headless.
- App discovery is live from the user's installed bundles; there is no copied
  catalog and no deployment step when another app adds an action.
- `schemaHint` is discovery help, not the source of validation. Validation
  remains inside the app bundle's Standard Schema.
- The API contract is JSON. Streaming, binary input, and callbacks wait for a
  concrete app that needs them.

## Why this shape

Successful systems converge on a stable action model with several entry
points. Readwise saves through its API, browser extension, and MCP server;
Home Assistant has one generic service-action API; Zapier integrations declare
typed actions; Apple App Intents exposes one action model to system surfaces.
The reusable asset is the action contract, not any particular UI or protocol.

MCP then becomes a discovery-friendly agent adapter, while deep links remain a
local navigation/confirmation adapter. Neither needs a second implementation
of application behaviour. See [references.md](references.md) for source links
and the concrete lessons retained here.

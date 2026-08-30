---
status: later
depends_on: T2, T4
milestone: 2
---

# T5: Add API-key auth and a CLI

## Result

A user can create a revocable Clerk user API key and use a small
`justcomputer` CLI to list, inspect, and run their apps through the same HTTP
gateway.

This is the first non-browser consumer. Start it only after Milestone 1 proves
the gateway contract.

## Authentication

Enable Clerk user API keys and accept `Authorization: Bearer ak_...` on the
three `/api/v1/apps` routes. A verified key's user subject selects the same
per-user Durable Object as a session token.

For this milestone, every valid user API key has full action access. Do not
define scopes or claims. Users still need create/list/revoke controls, either
through Clerk's provided API-key UI in the existing profile surface or one thin
Settings integration.

Reuse the verification pattern already present in
[`platform/worker/src/worker/index.ts`](../../platform/worker/src/worker/index.ts):
verify opaque `ak_` secrets with Clerk, map `subject` (or `createdBy` when
needed) to the user, and cache success/failure briefly. Prefer the current Clerk
Backend SDK method if it removes the hand-written REST call without widening
the change.

Only the versioned app-action routes accept this new credential in this task.
Do not accidentally grant API keys access to `/fs`, `/store`, other `/api`
routes, or WebSockets.

## CLI

Create a narrow Node CLI package at `platform/app-cli` with binary
`justcomputer`. Do not broaden the existing `files` binary, whose contract is
filesystem-specific.

Commands:

```text
justcomputer apps list
justcomputer apps inspect <app-id>
justcomputer apps run <app-id> <action> --params '<json-object>'
```

Configuration:

- `JUSTCOMPUTER_TOKEN` for the API key;
- `JUSTCOMPUTER_ORIGIN`, defaulting to the production Frieren origin; and
- command flags may override environment values for one invocation.

The CLI prints JSON to stdout on success, human-readable errors to stderr, and
uses non-zero exit codes for auth, usage, not-found, invalid-params, and runtime
failures. It never prints or persists the token. Shell configuration and an OS
credential helper are user choices; do not create a credential vault in this
task.

Now that a second client exists, extract only the proven HTTP transport into a
small shared package if the extension and CLI would otherwise duplicate
meaningful parsing/error code. Do not move extension auth or CLI configuration
into it.

## Tests

- valid, revoked, expired, malformed, and wrong-user API keys;
- API key accepted on app-action routes and rejected on unrelated routes;
- verification cache expiry and no token logging;
- CLI request construction for nested JSON params;
- exit-code and stderr mapping for every gateway error code; and
- a CLI run of `justfiles.read/save` against a mocked gateway.

## Acceptance

```sh
JUSTCOMPUTER_TOKEN=ak_... \
  justcomputer apps run justfiles.read save \
  --params '{"input":"https://example.com/article"}'
```

The command saves the page to the key owner's Read library. Revoking the key in
Clerk makes the next request fail without a Frieren deployment.

## References

- [Clerk user API keys](https://clerk.com/docs/guides/development/machine-auth/api-keys)

## Non-goals

- API-key scopes, service accounts, organization ownership, delegated grants,
  OAuth device flow, or token exchange.
- A plugin system or generated command for every app action.

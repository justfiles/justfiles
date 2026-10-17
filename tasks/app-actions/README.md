# App actions outside Frieren

> Status: **planned.** Milestone 1 is an installable **Just Computer** Chrome
> extension that signs in with the existing Clerk account and saves the active
> page to Read.

This story gives every installed app one reusable way to expose its existing
actions outside the Frieren UI. The first consumer is a browser extension and
the first action is `justfiles.read/save`; the names and protocol are platform
wide from the start.

Read [the design](00-design.md) before starting an implementation task. External
references and the lessons taken from them are in [references.md](references.md).

## Milestone 1

```text
Chrome toolbar
  -> Just Computer extension background worker
  -> Clerk session token
  -> POST /api/v1/apps/justfiles.read/actions/save
  -> the user's Frieren Durable Object
  -> existing AppController.run(...)
  -> Read's existing save procedure
```

The milestone is complete when a user can:

1. Load the unpacked extension in Chrome.
2. Sign in through Just Computer, or reuse an existing Just Computer sign-in.
3. Open any HTTP or HTTPS page and click **Save to Read**.
4. See a success or useful error in the extension.
5. Open Read and find the saved item.

After the account has booted Frieren and synced its built-ins once, saving must
work while no Frieren tab is open.

## Fixed decisions

- The HTTP action gateway is the canonical integration surface. The extension,
  CLI, MCP server, and future clients are adapters over it.
- A valid credential has full control over every action on every installed app
  in that account. There is no `external` flag, scope table, consent prompt, or
  per-app grant in this story.
- "Every action" means the existing agent-visible `AppController` surface.
  Procedures marked `audience: 'gui'` remain internal UI plumbing.
- The extension is named and located generically: product **Just Computer**,
  proposed package `platform/browser-extension`, never `read-extension`. It is
  a platform client, not an app installed inside Frieren.
- The extension uses WXT. Milestone 1 ships a Chrome MV3 build, while WXT keeps
  entrypoints, manifest generation, and extension APIs ready for later Firefox
  and other browser builds.
- Read-specific extension code is one thin command that calls the generic
  client with `justfiles.read`, `save`, and `{ input: url }`.
- The extension uses a short-lived Clerk session token. A long-lived API key is
  appropriate for a CLI or local MCP process, not for a distributed extension.
- Mutations use authenticated `POST`. A URL scheme or ordinary `GET` never
  performs a silent mutation.

## Work plan

Status values: `todo`, `in progress`, `done`, `later`.

| #  | Task                                                                 | Depends on | Status      | Milestone |
|----|----------------------------------------------------------------------|------------|-------------|-----------|
| T1 | [Prepare Clerk extension authentication](01-clerk-extension-auth.md) | Design     | done        | 1         |
| T2 | [Add the generic action gateway](02-action-gateway.md)               | Design     | done        | 1         |
| T3 | [Build the Just Computer browser extension](03-browser-extension.md) | T1, T2     | in progress | 1         |
| T4 | [Prove Read end to end](04-read-e2e.md)                              | T3         | in progress | 1         |
| T5 | [Add API-key auth and a CLI](05-api-keys-and-cli.md)                 | T2, T4     | later       | 2         |
| T6 | [Expose the gateway through MCP](06-mcp.md)                          | T5         | later       | 2         |
| T7 | [Add deep-link entry points](07-deep-links.md)                       | T2, T4     | later       | n/a       |

T1 and T2 are independent and may run in parallel. Then run T3 and T4 in
order. Milestone 1 stops at T4; do not pull T5 through T7 into it.

```text
             ┌─ T1 Clerk auth ─┐
Design ──────┤                 ├─ T3 extension ─ T4 end-to-end
             └─ T2 gateway ────┘                    │
                                                    ├─ T5 API key + CLI ─ T6 MCP
                                                    └─ T7 deep links
```

## Rules shared by every task

- Keep the generic core to list, inspect, and run. Do not add workflows,
  queues, webhooks, a permission registry, or an action catalog database.
- Reuse `AppController`; do not build a second app execution path.
- Preserve app schema validation inside the kernel. The gateway validates only
  transport shape and then reports app validation failures clearly.
- Never place a Clerk secret key, API key, session token, or CRX private key in
  source, logs, URLs, extension UI, or a shipped bundle.
- Use stable app IDs and action names as the contract. Display names are not
  identifiers.
- Implement each task in its own branch and worktree. Run the repository test
  workflow before handing it off.

## Known prerequisite

Frieren currently materialises built-in app bundles in the browser and syncs
them to the server; the Durable Object does not seed them. Milestone 1 therefore
requires the user to have opened Frieren successfully at least once. The API
must return an actionable `app_not_installed` error when the server cannot find
Read. Server-side built-in materialisation is a separate platform concern, not
part of this story.

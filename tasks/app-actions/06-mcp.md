---
status: later
depends_on: T5
milestone: 2
---

# T6: Expose app actions through MCP

## Result

Codex and other local agents can operate installed Just Computer apps through a
small local MCP server backed by the same action gateway and user API key.

## Shape

Create a local stdio server with three stable tools:

```text
apps_list()
apps_inspect({ appId })
apps_run({ appId, action, params })
```

Do not register one MCP tool per app action. The installed app set and schemas
change at runtime; three generic tools keep the tool list stable and mirror the
existing internal `app list` → `app inspect` → `app run` interaction.

The server reads `JUSTCOMPUTER_TOKEN` and optional `JUSTCOMPUTER_ORIGIN`, then
uses the shared client proven in T5. It owns no app logic, Clerk verification,
storage, or permissions.

`apps_inspect` returns action descriptions, kinds, examples, and `schemaHint`
so an agent can form the next call. `apps_run.params` remains a JSON object;
the app bundle performs authoritative validation.

## Codex setup

Document one local configuration that launches the stdio process and passes
the token through the process environment or an environment-variable reference.
Do not place the raw token in a committed project configuration.

Codex supports local stdio and remote Streamable HTTP MCP servers. Use local
stdio first because T5 already has a personal bearer credential and it avoids
building an OAuth authorization server. If a hosted multi-client MCP endpoint
later becomes a product requirement, implement standards-based MCP OAuth then;
do not expose a public remote MCP server with one shared secret.

## Tests

- tool discovery returns exactly the three stable tools;
- list/inspect/run calls map to the HTTP client without alteration;
- gateway errors become MCP tool errors with actionable messages;
- app action results remain structured MCP content where possible;
- no token appears in tool schemas, results, logs, or error data; and
- an integration fixture proves the inspect-then-run loop against Read.

## Acceptance

From a Codex task configured with the local server, an agent can:

1. call `apps_list` and find `justfiles.read`;
2. call `apps_inspect` and discover `save` plus its input hint; and
3. call `apps_run` with a URL and observe the item in Read.

No Read-specific MCP code or tool exists.

## References

- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

## Non-goals

- Dynamic per-action MCP tools, remote hosting, OAuth authorization-server
  metadata, prompts/resources, or agent-specific permissions.

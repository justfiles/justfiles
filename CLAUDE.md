# Tools
use bun for package management.

use tab for indentation.

# Monorepo Structure

| Package         | Description                                                |
|-----------------|------------------------------------------------------------|
| `apps/worker`   | Cloudflare Worker — REST API, MCP server, and React web UI |
| `apps/cli`      | Agent-friendly CLI for interacting with the backend        |
| `packages/core` | Shared memory store logic (DB, embeddings, search)         |

# Memory

IMPORTANT: ghostore IS the memory system. The built-in Claude Code auto-memory is DISABLED for this project.

- NEVER write to `~/.claude/projects/*/memory/` or any built-in memory directory
- ALL memory operations MUST use the `ghostore` CLI
- When the user says "remember", "capture", "save this", "write to memory", etc. — use ghostore, not the built-in system

Read memory `readme` from ghostore before any memory related action happening, if haven't read it already.
```sh
ghostore get "readme"
```

The project name is `ghostore` for this project.

# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command                | Purpose                   |
|------------------------|---------------------------|
| `bunx wrangler dev`    | Local development         |
| `bunx wrangler deploy` | Deploy to Cloudflare      |
| `bunx wrangler types`  | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`


# Testing

Make sure the following tests pass after making file changes:
```sh
bun run typecheck
```

# Workspace Packages

- `@justfiles/fs` is `dist`-first in `package.json` exports. Do not rely on `publishConfig` to rewrite exports for Bun.
- Local workspace source resolution uses the custom export condition `@justfiles/src`.
- TypeScript configs opt into `@justfiles/src` via `compilerOptions.customConditions` for IDE/typecheck.
- Vite must preserve its default conditions and prepend `@justfiles/src` via `defaultClientConditions`; do not replace the full list with hard-coded literals.
- External consumers, including `bun link`, should resolve workspace packages to `dist` unless they explicitly opt into `@justfiles/src`.

If the change is a api/mcp change, test it before call it done. Test the api directly against http://localhost:5173
use the API_KEY from .agent file to get access

## Local dev ports

- **http://localhost:5173** — Vite + Cloudflare plugin dev server. Serves both the React app AND the worker. This is the correct target for API/MCP testing.

## API routes

All REST endpoints are mounted at `/api` (e.g. `POST /api/v1/write`, `GET /api/v1/status`).
The MCP endpoint is at `/mcp`.

The write endpoint is `POST /api/v1/write` (not `/api/v1/memory`).

MCP calls require `Accept: application/json, text/event-stream` header alongside `Content-Type: application/json`.

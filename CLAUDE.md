# Tools
use bun for package management.

use tab for indentation.

# Memory

use ghostore (via mcp) as memory source. anything about memory, it means in ghostore.
Read memory `readme` (path) from ghostore before any memory related action happening. Do not need to read if memory is never involved. The project name is "ghostore" for this project.

# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command               | Purpose                   |
|-----------------------|---------------------------|
| `npx wrangler dev`    | Local development         |
| `npx wrangler deploy` | Deploy to Cloudflare      |
| `npx wrangler types`  | Generate TypeScript types |

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

If the change is a api/mcp change, test it before call it done. Test the api directly against http://localhost:5173
use the API_KEY from .agent file to get access

## Local dev ports

- **http://localhost:5173** — Vite + Cloudflare plugin dev server. Serves both the React app AND the worker. This is the correct target for API/MCP testing.

## API routes

All REST endpoints are mounted at `/api` (e.g. `POST /api/v1/write`, `GET /api/v1/status`).
The MCP endpoint is at `/mcp`.

The write endpoint is `POST /api/v1/write` (not `/api/v1/memory`).

MCP calls require `Accept: application/json, text/event-stream` header alongside `Content-Type: application/json`.

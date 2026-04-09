# Justfiles

A focused memory service for humans and AI agents.

This is a monorepo with three packages:

| Package         | Description                                                |
|-----------------|------------------------------------------------------------|
| `apps/worker`   | Cloudflare Worker — REST API, MCP server, and React web UI |
| `apps/cli`      | Agent-friendly CLI for interacting with the backend        |
| `packages/core` | Shared memory store logic (DB, embeddings, search)         |

## CLI

The `files` CLI is designed for scripting and AI agent use. It has good help/error message that helps agents discover the usage in a "progressive disclosure" way. (Saves token, only read when needs them)

```sh
# Configure once
cat > ~/.config/files/config.js <<'EOF'
export default {
	defaultVolume: 'local',
	volumes: {
		local: './notes'
	}
}
EOF

# Commands
files write --path notes/foo "Hello world"
files get notes/foo
files search "something I remember"
files ls notes/
```

Global flags: `--config`, `--volume` (or env `FILES_VOLUME`), `--json`, `--quiet`.

## MCP

Justfiles exposes an MCP server at `/mcp`. To connect an AI agent, add it to your `mcp.json` with a Clerk API key (generate one from the Justfiles web UI):

```json
{
  "mcpServers": {
    "justfiles": {
      "type": "http",
      "url": "https://justfiles.app/mcp",
      "headers": {
        "Authorization": "Bearer ak_YOUR_API_KEY"
      }
    }
  }
}
```

### Tools

| Tool             | Description                                                                                 |
|------------------|---------------------------------------------------------------------------------------------|
| `write_memory`   | Write a memory at a path. `mode`: `w` overwrite (default), `a` append, `x` exclusive create |
| `search_memory`  | Hybrid/semantic/exact search with optional tag and path filters                             |
| `update_memory`  | Update content, path, title, or tags of an existing memory by ID                            |
| `list_memories`  | List memories by `path_prefix`, glob `path_pattern`, tags, or date range                    |
| `get_memory`     | Fetch a memory by ID or path                                                                |
| `archive_memory` | Soft-delete one or more memories by ID                                                      |
| `link_memories`  | Create a directed relationship between two memories                                         |

## Development

```sh
bun install
bun dev
```

### Environment and secrets

**Build-time (Vite frontend):**

- `VITE_CLERK_PUBLISHABLE_KEY`: Clerk publishable key — required at build time for the React frontend.

**Worker runtime secrets:**

- `OPENAI_KEY`: OpenAI API key — required for memory embedding and LLM processing.
- `CLERK_SECRET_KEY`: Clerk secret key — required for JWT session auth and API key verification.
- `CLERK_PUBLISHABLE_KEY`: Clerk publishable key — required by the Clerk middleware in the worker.
- `GOOGLE_PROJECT_ID`: Google Cloud project ID — optional, enables the Vertex AI reranker when set alongside `GOOGLE_SA_KEY`.
- `GOOGLE_SA_KEY`: Google service account key JSON — optional, enables the Vertex AI reranker.

#### Local development

Use one of the local flows:

- Frontend-only development (Vite server):

  ```sh
  # create .env.local with:
  #   VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
  # then run:
  bun dev
  ```

- Worker-backed development with Wrangler:

  ```sh
  cat > .dev.vars <<'EOF'
  OPENAI_KEY=sk-...
  CLERK_SECRET_KEY=sk_test_...
  CLERK_PUBLISHABLE_KEY=pk_test_...
  VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
  # Optional: enable Google Vertex AI reranker
  # GOOGLE_PROJECT_ID=...
  # GOOGLE_SA_KEY={"type":"service_account",...}
  EOF
  bunx wrangler dev
  ```

The dev server starts a local Cloudflare Worker with a Durable Object backed by a persisted SQLite file at `.wrangler/state/v3/do/`.

### Database (dev)

Migrations run automatically on the **first request** after startup.

The local SQLite state persists across restarts. If you need a clean slate:

```sh
rm -rf .wrangler/state
```

### Schema changes

1. Add a new SQL file at `packages/core/src/migrations/NNNN_<name>.sql` with your DDL changes.
2. Import and register it in `packages/core/src/migrations/index.ts` by appending an entry to the `coreMigrations` array with the next version number.
3. Commit both files together.

## Production

```sh
bun run build
bun run deploy
```

Set runtime secrets in Cloudflare before deploying:

```sh
bunx wrangler secret put OPENAI_KEY
bunx wrangler secret put CLERK_SECRET_KEY
bunx wrangler secret put CLERK_PUBLISHABLE_KEY
```

Each Durable Object instance has its own embedded SQLite database managed by Cloudflare — no separate provisioning needed. Migrations run automatically on the first request.

To export data from a live instance, use the **Download DB** button in the UI, which downloads the `memories` table as JSON via `GET /api/v1/export`.

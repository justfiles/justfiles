# Ghostore

A focused memory service for humans and AI agents.

## MCP

Ghostore exposes an MCP server at `/mcp`. To connect an AI agent, add it to your `mcp.json` with a Clerk API key (generate one from the Ghostore web UI):

```json
{
  "mcpServers": {
    "ghostore": {
      "type": "http",
      "url": "https://ghostore.net/mcp",
      "headers": {
        "Authorization": "Bearer ak_YOUR_API_KEY"
      }
    }
  }
}
```

### Tools

| Tool | Description |
|------|-------------|
| `write_memory` | Write a memory at a path. `mode`: `w` overwrite (default), `a` append, `x` exclusive create |
| `search_memory` | Hybrid/semantic/exact search with optional tag and path filters |
| `update_memory` | Update content, path, title, or tags of an existing memory by ID |
| `list_memories` | List memories by `path_prefix`, glob `path_pattern`, tags, or date range |
| `get_memory` | Fetch a memory by ID or path |
| `archive_memory` | Soft-delete one or more memories by ID |
| `link_memories` | Create a directed relationship between two memories |

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

  or set it inline:

  ```sh
  VITE_CLERK_PUBLISHABLE_KEY=pk_test_... bun dev
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

  For local API smoke tests that bypass Wrangler, export the needed env vars in your shell or `.env`.

#### Production release

- Set runtime secrets in Cloudflare (values are injected from environment during deployment):

  ```sh
  bunx wrangler secret put OPENAI_KEY
  bunx wrangler secret put CLERK_SECRET_KEY
  bunx wrangler secret put CLERK_PUBLISHABLE_KEY
  # Optional: enable Google Vertex AI reranker
  bunx wrangler secret put GOOGLE_PROJECT_ID
  bunx wrangler secret put GOOGLE_SA_KEY
  ```

- Build and deploy with the Clerk publishable key available at build time:

  ```sh
  VITE_CLERK_PUBLISHABLE_KEY=pk_live_... bun run build
  bun run deploy
  ```

  If your platform runs commands in separate steps, run:

  ```sh
  export VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
  bun run build
  bun run deploy
  ```

- To verify:

  ```sh
  bunx wrangler secret list
  bunx wrangler deploy --dry-run
  ```

The dev server starts a local Cloudflare Worker with a Durable Object backed by a persisted SQLite file at `.wrangler/state/v3/do/`.

### Database (dev)

Migrations run automatically on the **first request** after startup. The Durable Object constructor calls `migrateCF(storage)` inside `blockConcurrencyWhile`, blocking all requests until pending migrations complete.

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

The production settings above assume the release environment has the variables from the "Production release" section configured.

### Database (prod)

Each Durable Object instance has its own embedded SQLite database managed by Cloudflare. There is no separate provisioning step.

Migrations run automatically on the first request to each Durable Object instance. For a brand-new deployment all migrations run in sequence on first request; for an existing deployment only new migrations run.

To export data from a live instance, use the **Download DB** button in the UI, which downloads the `memories` table as JSON via `GET /api/v1/export`.

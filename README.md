# Justfiles

A focused memory service for humans and AI agents.

This is a monorepo with three packages:

| Package         | Description                                                |
|-----------------|------------------------------------------------------------|
| `apps/worker`   | Cloudflare Worker — filesystem API and React web UI        |
| `apps/cli`      | Agent-friendly CLI for interacting with the backend        |
| `packages/core` | Shared filesystem API, SQLite migrations, and storage      |

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
files stat notes/foo
files ls notes/
```

Global flags: `--config`, `--volume` (or env `FILES_VOLUME`), `--json`, `--quiet`.

## Development

```sh
bun install
bun dev
```

### Environment and secrets

**Build-time (Vite frontend):**

- `VITE_CLERK_PUBLISHABLE_KEY`: Clerk publishable key — required at build time for the React frontend.

**Worker runtime secrets:**

- `CLERK_SECRET_KEY`: Clerk secret key — required for JWT session auth and API key verification.
- `CLERK_PUBLISHABLE_KEY`: Clerk publishable key — required by the Clerk middleware in the worker.

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
  CLERK_SECRET_KEY=sk_test_...
  CLERK_PUBLISHABLE_KEY=pk_test_...
  VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
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
bunx wrangler secret put CLERK_SECRET_KEY
bunx wrangler secret put CLERK_PUBLISHABLE_KEY
```

Each Durable Object instance has its own embedded SQLite database managed by Cloudflare — no separate provisioning needed. Migrations run automatically on the first request.

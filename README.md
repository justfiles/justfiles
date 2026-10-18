# Justfiles

A focused memory service for humans and AI agents.

The workspace has three top-level groups:

| Directory | Contents |
| --- | --- |
| `platform/` | JustFiles hosts, services, CLI, and documentation |
| `apps/` | Installable apps |
| `packages/` | Shared libraries and tooling |

## Creating an app package

Use the local create package with Node from the repo root:

```sh
node packages/create-app/index.js apps/my-new-app
pnpm install
```

This uses `packages/create-app` from the working tree, not npm. Avoid `pnpm create @justfiles/app ...` or `pnpm dlx @justfiles/create-app ...` when you need the local version.

If the target directory already exists and is non-empty:

```sh
node packages/create-app/index.js apps/my-new-app --force
```

Then run it with:

```sh
cd apps/my-new-app
pnpm dev
```

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
pnpm install
pnpm dev
```

Run pnpm commands from the repository root. The root workspace replaces every
`@justfiles/app` dependency with the local `packages/app`.

`pnpm dev` builds the apps present under `apps/`, serves their artifacts from one
local app store, and rebuilds them when their source changes. Frieren seeds its
built-ins from that store and uses it in place of justapps.run for other apps that
are already installed. Set `VITE_FRIEREN_DEV_APP_STORE` to keep using an external
development store instead.

Turbo builds and type-checks every package. Root format, lint, and test commands
cover `platform/`, `apps/`, and `packages/`.

### Environment and secrets

**Build-time (Vite frontend):**

- `VITE_CLERK_PUBLISHABLE_KEY`: Clerk publishable key — required at build time for the React frontend.

**Worker runtime config:**

- `CLERK_SECRET_KEY`: Clerk secret key — required for JWT session auth and API key verification.
- `CLERK_PUBLISHABLE_KEY`: Clerk publishable key — required by the Clerk middleware in the worker. This is non-sensitive and should live in `wrangler.jsonc` `vars`, not Cloudflare secrets.
- `ENCRYPTION_KEY` (frieren): this host's root secret for encryption at rest — the key that never lives in the Volume it protects. Any high-entropy string (`openssl rand -base64 32`). It is never a key directly: each use derives its own subkey (HKDF), so one secret covers every at-rest need; a new one must pick its own derivation label. Today it seals connected-account credentials. Absent locally ⇒ stored in the clear (a startup warning says so); **changing it makes existing accounts unreadable**, so they list as broken and must be re-connected. Use a different value per environment.

#### Local development

Use one of the local flows:

- Frontend-only development (Vite server):

  ```sh
  # create .env.local with:
  #   VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
  # then run:
  pnpm dev
  ```

- Worker-backed development with Wrangler:

  ```sh
  cat > .dev.vars <<'EOF'
  CLERK_SECRET_KEY=sk_test_...
  VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
  EOF
  CLOUDFLARE_ENV=dev vite
  ```

`platform/worker/wrangler.jsonc` provides the local Worker runtime `CLERK_PUBLISHABLE_KEY` for the `dev` environment. `platform/worker/.env` provides the frontend build-time `VITE_CLERK_PUBLISHABLE_KEY`. Keep them pointed at the same Clerk project.

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
pnpm run build
pnpm run deploy
```

Set runtime secret(s) in Cloudflare before deploying:

```sh
pnpm dlx wrangler secret put CLERK_SECRET_KEY
```

Each Durable Object instance has its own embedded SQLite database managed by Cloudflare — no separate provisioning needed. Migrations run automatically on the first request.

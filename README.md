# Justfiles

The monorepo behind **Just Computer**, a desktop where small apps and an AI agent share one
synced Volume of files. Each app is a state machine with a GUI for people and typed actions
for the agent, so both work on the same state.

| Directory | Contents |
| --- | --- |
| `platform/` | Hosts and services (below) |
| `apps/` | First-party apps |
| `packages/` | The app framework, the agent, the file system, shared UI, tooling |
| `docs/` | Guides for building apps and working on the platform |

| Platform | What it is |
| --- | --- |
| `platform/frieren` | Just Computer on the web ([justcomputer.app](https://justcomputer.app)): a Cloudflare Worker with one Durable Object per user, and the React shell |
| `platform/mac` | Just Computer for Mac: a native launcher and one `.app` per installed app, over a local Bun daemon |
| `platform/runner` | JustApps ([justapps.run](https://justapps.run)): the app registry and hosted apps |
| `platform/worker` | The Just Files volume service ([justfiles.app](https://justfiles.app)) |
| `platform/cli` | `files`, a CLI for Just Files volumes |
| `platform/browser-extension` | The Just Computer browser extension |
| `platform/docs` | The docs site, built from `docs/` |

## Building an app

Start with [docs/app.md](docs/app.md). To create one from the template in this tree:

```sh
node packages/create-app/index.js apps/my-new-app
pnpm install
```

This uses `packages/create-app` from the working tree. `pnpm create @justfiles/app` and
`pnpm dlx @justfiles/create-app` fetch the published version instead. Pass `--force` to
write into a directory that already has files.

## CLI

`files` reads and writes Just Files volumes, local folders or remote. It is built for
scripts and agents: every command has focused help, structured exit codes and usage-rich
errors, so an agent can discover it a step at a time.

```sh
npm install -g @justfiles/cli

# Configure once
cat > ~/.config/files/config.js <<'EOF'
export default {
	defaultVolume: 'local',
	volumes: {
		local: './notes'
	}
}
EOF

files write --parents notes/foo.md "Hello world"
files cat notes/foo.md
files stat notes/foo.md
files ls notes/
```

Global flags: `--config`, `--volume` (or env `FILES_VOLUME`), `--json`, `--quiet`. Run
`files --help` for remote volumes.

## Development

```sh
pnpm install
pnpm dev
```

Run pnpm commands from the repository root. The root workspace replaces every
`@justfiles/app` dependency with the local `packages/app`.

`pnpm dev` builds the apps under `apps/`, serves their artifacts from one local app store,
rebuilds them when their source changes, and starts the web client against that store.
Set `VITE_FRIEREN_DEV_APP_STORE` to use an external development store instead. The Mac
host has its own dev loop; see [platform/mac/README.md](platform/mac/README.md).

Before a PR, run what CI runs:

```sh
pnpm typecheck
pnpm lint
pnpm test
```

### Local configuration

The web client needs two git-ignored files in `platform/frieren`:

- `.env`: `VITE_CLERK_PUBLISHABLE_KEY`, the Clerk publishable key the frontend is built with.
- `.dev.vars`: the Worker secrets that `wrangler.jsonc` lists under `secrets.required`.

The Worker secrets:

- `CLERK_SECRET_KEY`: verifies Clerk sessions.
- `OPENROUTER_API_KEY`: the built-in AI.
- `ENCRYPTION_KEY`: this host's root secret for encryption at rest, the key that never
  lives in the Volume it protects. Any high-entropy string (`openssl rand -base64 32`).
  Each use derives its own subkey (HKDF); today it seals connected-account credentials.
  Without it, credentials are stored in the clear and a startup warning says so.
  **Changing it makes existing accounts unreadable**, so they must be reconnected. Use a
  different value per environment.
- `CODEX_PROXY_KEY`: the shared key for the ChatGPT account proxy (see
  `platform/frieren/CHATGPT-ACCOUNT-DESIGN.md`).

`CLERK_PUBLISHABLE_KEY` is not secret and lives in `wrangler.jsonc` `vars`.

The local Worker runs a Durable Object backed by a SQLite file under
`platform/frieren/.wrangler/state/`.
Migrations run on the first request after startup, and the state persists across
restarts. Delete that folder for a clean slate.

### Schema changes

1. Add a new SQL file at `packages/core/src/migrations/NNNN_<name>.sql` with your DDL changes.
2. Register it in `packages/core/src/migrations/index.ts` by appending an entry to the
   `coreMigrations` array with the next version number.
3. Commit both files together.

## Releases and deploys

The web client and the volume service deploy from GitHub Actions only; never run
`wrangler deploy` for them by hand.

- A merge to `main` runs CI, then deploys the web client and the volume service to staging,
  each only when it changed.
- release-please keeps a release PR open for the web client, the npm packages and the
  apps, built from Conventional Commit messages. Merging it tags each release: a
  `frieren-v*` tag deploys the web client to production, package releases publish to npm,
  and an app release (`draw-v*`) gets the app's built `dist/` attached as its one zip.
  A new app joins by adding its folder to `release-please-config.json` and
  `.release-please-manifest.json`.
- The volume service deploys to production on a `worker-v*` tag.

[kb/rebrand-runbook.md](kb/rebrand-runbook.md) has the full deploy model, including why a
manual `wrangler deploy` lands on production.

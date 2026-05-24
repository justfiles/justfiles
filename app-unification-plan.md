# App Unification Migration Plan

End state: a single, sandboxed kernel-app architecture. Built-in apps (Finder,
Paint, Settings, Messages) are kernel apps with the same shape as any
third-party app, differentiated only by which capabilities the host grants
them. Built-ins ship with the worker, install themselves into the user's
volume on first launch, and update in place when their version changes.

## Architecture target

- One dispatch path in the kernel (the sandboxed Worker Loader path). No
  trusted/in-process branch.
- One mount path in the browser (`KernelAppFrame`). No `BuiltinHost`.
- One launcher entry shape (`{ id, name, description, iconUrl, version }`).
  No `kind: 'builtin' | 'app'` distinction at the UI layer.
- React, ReactDOM, and JSX runtime are shared across host and all apps via
  an import map. Apps externalize React in their bundle.
- New capability contracts (`volume{scope}`, `integrations`, `agent`) cover
  the host services built-ins need. Trusted built-ins get more permissive
  grants; the contract surface is the same.
- Built-in app bundles live as zipped assets in the worker. On DO boot,
  `ensureBuiltinsInstalled(kernel)` compares versions and reinstalls any
  that are missing or outdated. Near-zero cost on the happy path.

## Sequencing

Each part depends on the previous. Within a part, steps are ordered.

1. **Shared React runtime infrastructure.** Unblocks every app using React.
2. **New capabilities** (`volume{scope}`, `integrations`) for migrating
   Finder/Paint/Settings without touching the agent.
3. **Built-in install pipeline.** Worker ships bundles, installs on boot.
4. **Migrate Paint** (smallest; exercises the pipeline end-to-end).
5. **Migrate Finder** (exercises `volume{scope:'system'}`).
6. **Migrate Settings** (exercises `integrations`).
7. **Subscription extension to capabilities.** Required for Messages.
8. **Migrate Messages** (exercises `agent` capability + subscriptions).
9. **Cleanup.** Delete `BuiltinHost`, the `kind` discriminator, and the
   old builtin table.

---

# Part 1 — Shared React runtime infrastructure

Goal: every kernel app's `gui.js` resolves `react`, `react-dom`,
`react-dom/client`, `react/jsx-runtime`, and `react/jsx-dev-runtime`
through the host's single React instance via an import map.

## Step 1.1 — Decide the shared stdlib

**Decision (this plan):** stdlib is React-only.

Specifiers to externalize and serve from the host:

- `react`
- `react-dom`
- `react-dom/client`
- `react/jsx-runtime`
- `react/jsx-dev-runtime`

Nothing else is shared in this iteration. `@phosphor-icons/react`, shadcn
components, etc. stay bundled per-app or get added to the stdlib later if
duplication becomes painful.

**Verify:** decision recorded here. No code change.

## Step 1.2 — Host emits vendor bundles for the stdlib

Produce stable ESM bundles for each stdlib specifier, served as static
assets from the host.

**Files:**

- New: `apps/frieren/scripts/build-vendor.ts` — invokes `esbuild` to bundle
  each specifier (resolved from the host's own `node_modules`) into a
  single-file ESM module.
- New outputs: `apps/frieren/public/vendor/react.js`,
  `react-dom.js`, `react-dom-client.js`, `jsx-runtime.js`,
  `jsx-dev-runtime.js`.
- `apps/frieren/package.json` — prepend `bun scripts/build-vendor.ts` to
  the `build` script (and to `dev` via a `prebuild` step or one-time
  manual run; the outputs check into `public/` so dev works immediately).
- `.gitignore` — keep `public/vendor/` ignored or check it in; pick one
  and document. Recommendation: ignore; emit on `pnpm install`
  postinstall and on `build`.

**Verify:**
```sh
cd apps/frieren && bun scripts/build-vendor.ts
ls public/vendor/  # five .js files
node --input-type=module -e "import('./public/vendor/react.js').then(m => console.log(Object.keys(m)))"
# expect: useState, useEffect, …
```

## Step 1.3 — Import map in `index.html`

**Files:**

- `apps/frieren/index.html` — add:

```html
<script type="importmap">
{
  "imports": {
    "react": "/vendor/react.js",
    "react-dom": "/vendor/react-dom.js",
    "react-dom/client": "/vendor/react-dom-client.js",
    "react/jsx-runtime": "/vendor/jsx-runtime.js",
    "react/jsx-dev-runtime": "/vendor/jsx-dev-runtime.js"
  }
}
</script>
```

The import map only affects dynamically-loaded ESM (the app `gui.js`
fetches). The host's own bundle is processed by Vite and resolves React
via Node module resolution at build time — both paths converge on the
same physical bytes because the host emits them itself in step 1.2.

**Verify:**
- Load the host page. DevTools → Application → check the import map
  appears in the Sources panel.
- No console warnings about duplicate React instances when an app is open.

## Step 1.4 — Tailwind content scan covers all kernel apps

Tailwind v4 with `@tailwindcss/vite` uses `@source` directives in the CSS.
Extend the host's CSS to scan kernel-app sources so utility classes used
in app GUIs end up in the host's compiled CSS.

**Files:**

- `apps/frieren/src/index.css` — add near the existing `@theme inline`:

```css
@source "../../../packages/app-*/src/**/*.{ts,tsx}";
```

(adjust depth as needed; verify path by counting `..` from
`apps/frieren/src/`).

**Verify:**
- Add a temporary class like `bg-emerald-500` to a crossword GUI element.
- `pnpm --filter frieren build`.
- `grep emerald` in `apps/frieren/dist/assets/*.css` finds the class.
- Revert the temporary change.

## Step 1.5 — `kernelHost` plugin externalizes the stdlib in build mode

**Files:**

- `packages/app/vite.ts` — in the `config` hook's build branch, add:

```ts
build: {
  outDir: 'dist',
  emptyOutDir: true,
  lib: { entry: resolve(root, opts.gui), formats: ['es'], fileName: () => 'gui.js' },
  rollupOptions: {
    external: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime'
    ]
  }
}
```

Serve mode is unchanged — standalone `vite dev` in an app folder keeps
its own React for isolated authoring.

**Verify:**
```sh
pnpm --filter @justfiles/app-crossword build
grep -c "useState" packages/app-crossword/dist/gui.js
# expect: 0 (React internals not bundled — import * from 'react' resolves at runtime)
grep -c "from\"react\"" packages/app-crossword/dist/gui.js
# expect: >=1 (bare specifier preserved)
```

## Step 1.6 — Content-addressed `gui.js` URL + immutable cache

Today: `/api/kernel/:id/gui.js?token=...`. Cache busts on every token
rotation.

**Change:** include the manifest's `version` (or content hash) in the
URL, and serve hashed URLs with `Cache-Control: private, max-age=31536000, immutable`.

**Files:**

- `packages/app/app.ts` — `AppManifest` already has `version`. No change.
- `apps/frieren/worker/frieren.app.ts`:
  - `asset()` — when serving `gui.<version>.js` (or `gui.<hash>.js`),
    set `Cache-Control: private, max-age=31536000, immutable`.
  - List endpoint includes the version-stamped GUI URL in the launcher
    payload (so the client knows which URL to import).
- `apps/frieren/src/KernelAppFrame.tsx` — replace the hardcoded
  `gui.js` path with the manifest-provided URL.

Token still rides the query string. Within one token's lifetime, the
content-addressed URL caches; across rotations, the cache misses but
hits the same bytes. Acceptable. Service-worker caching is a future
optimization, out of scope here.

**Verify:**
- Launch an app twice in the same session. Network panel: second load is
  `(disk cache)`.
- Bump a published app's version; relaunch; network panel: fresh download
  because the URL changed.

## Step 1.7 — Migrate `app-crossword` to externalized build and system styling

This is the canary. If crossword still works end-to-end after this step,
the runtime infra is good.

**Files:**

- `packages/app-crossword/package.json` — move `react`, `react-dom` from
  `dependencies` to `peerDependencies` (or remove from dependencies and
  keep `@types/react` in devDependencies). Bundling against host React's
  exact version is enforced by workspace deps.
- `packages/app-crossword/src/style.ts` — delete; replace inline css with
  Tailwind utility classes throughout `gui.tsx`. Use the host's design
  tokens (CSS variables defined in `apps/frieren/src/index.css`
  `@theme inline` block — `var(--text)`, `var(--surface)`, etc.) via
  Tailwind arbitrary values where needed.
- `packages/app-crossword/src/gui.tsx` — restyle to match the system
  aesthetic; ensure it visually fits the host shell.

**Verify:**
```sh
pnpm --filter @justfiles/app-crossword build
ls packages/app-crossword/dist  # app.js, gui.js, manifest.json
cd apps/frieren && bun run dev
# in another shell:
bun run verify:ui
# install crossword (existing dev flow) and run through one full game
```

Expected: crossword renders with the system theme, no double-React warnings,
all actions (start, enter, reveal, check) work.

## Step 1.8 — Document app-authoring discipline

**Files:**

- `packages/app/README.md` — add three short sections:
  1. **Shared runtime.** Apps externalize `react`, `react-dom`,
     `react-dom/client`, `react/jsx-runtime`. `kernelHost` does this
     automatically; don't override.
  2. **State discipline.** Reducer state = semantic, persistable, agent-
     inspectable. Transient interaction (drag positions, scroll, in-
     progress input) stays in GUI-local React state. Don't dispatch on
     every keystroke or pointer-move.
  3. **Capabilities.** Declare every host service you touch in the app's
     `capabilities` field. Even if the host grants you broad access
     today, declaring keeps the agent's `app actions` view honest.

**Verify:** README updated; no code change.

---

# Part 2 — New capabilities (request/response only)

Goal: contracts and host implementations for `volume{scope}` and
`integrations`. These are pure request/response — no subscription work
yet.

## Step 2.1 — `volume` capability gains a scope option

**Files:**

- `packages/app/capabilities/volume/contract.ts` — extend the interface:

```ts
export interface VolumeCapability {
  readFile(input: { path: string }): Promise<Uint8Array>
  writeFile(input: { path: string; data: Uint8Array }): Promise<void>
  mkdir(input: { path: string; recursive?: boolean }): Promise<void>
  scan(input: { path: string }): Promise<Array<{ path: string; type: 'file' | 'dir' }>>
  exists(input: { path: string }): Promise<boolean>
}
```

- `packages/app/capabilities/volume/index.ts` — the factory takes
  `scopes` already; document that `'system'` means root-volume access
  (host enforces). Other scope strings mean specific path prefixes.

- `apps/frieren/worker/frieren.app.ts` — extend `invokeCapability` with
  a `volume` branch. Use the app's bundle scopes from the manifest to
  decide what volume to hand back: `'system'` → host fs; specific prefix
  → `chroot(fs, prefix)`; missing → existing per-app `chroot` at
  `/applications/:id/data/files`.

**Verify:**
- Existing apps unaffected (default scope is per-app chroot).
- Unit test: a sandboxed app declaring `volume({ scopes: ['system'] })`
  can read a file outside its own `data/files` dir.

## Step 2.2 — `integrations` capability

**Files:**

- New: `packages/app/capabilities/integrations/contract.ts`:

```ts
export interface IntegrationField {
  type: 'string'
  minLength?: number
  description?: string
}

export interface IntegrationDescriptor {
  id: string
  name: string
  description: string
  credentialsSchema: { type: 'object'; properties: Record<string, IntegrationField>; required?: string[] }
  connectedAccounts: ReadonlyArray<{ accountId: string; lastError?: string }>
}

export interface IntegrationsCapability {
  list(input: {}): Promise<IntegrationDescriptor[]>
  connect(input: { id: string; accountId: string; credentials: Record<string, string> }): Promise<void>
  disconnect(input: { id: string; accountId: string }): Promise<void>
}
```

- New: `packages/app/capabilities/integrations/index.ts` — exports the
  factory.
- `apps/frieren/worker/frieren.app.ts` — add an `integrations` branch in
  `invokeCapability`. Implementation delegates to the existing
  `/api/integrations` handlers internally (refactor the handlers into a
  callable module if they aren't already).

**Verify:**
- Add an integration-using test: an app declaring `integrations` can
  list integrations; the result matches the REST endpoint's payload.

---

# Part 3 — Built-in install pipeline

Goal: built-in app bundles ship with the worker. On DO boot, the kernel
compares each built-in's bundled version against the installed version
and reinstalls only mismatches. Happy path: one `kernel.list()` call.

## Step 3.1 — Per-app version source

Each built-in lives in its own `packages/app-frieren-<name>/` directory,
with `package.json#version` as the source of truth.

**Files (new packages — created in Parts 4–8):**

- `packages/app-frieren-finder/`
- `packages/app-frieren-paint/`
- `packages/app-frieren-settings/`
- `packages/app-frieren-messages/`

Each has the standard kernel-app layout (`src/app.ts`, `src/gui.tsx`,
`vite.config.ts`, `package.json` with workspace dep on `@justfiles/app`).
`vite.config.ts` uses `kernelHost({ id: 'app.frieren.<name>', ... })`.

## Step 3.2 — Build script bundles each built-in as a zip asset

**Files:**

- New: `apps/frieren/scripts/build-builtins.ts` — for each builtin
  package:
  1. Run its `vite build` (via `pnpm --filter`).
  2. Zip the `dist/` contents (using `fflate`, same lib the worker
     already uses for unzipping).
  3. Write to `apps/frieren/worker/builtins/<id>.zip`.
  4. Emit a sidecar `apps/frieren/worker/builtins/<id>.meta.json`
     containing `{ id, version }` extracted from the bundle's
     `manifest.json`. This lets the worker version-check without
     unzipping.
- New: `apps/frieren/worker/builtins/index.ts` — generated import
  manifest:

```ts
// generated by scripts/build-builtins.ts — do not edit
import paintZip from './app.frieren.paint.zip'
import paintMeta from './app.frieren.paint.meta.json'
// ... other built-ins

export const BUILTINS = [
  { id: paintMeta.id, version: paintMeta.version, bytes: new Uint8Array(paintZip) },
  // ...
] as const
```

(The `.zip` import works via Wrangler's static asset handling or a Vite
loader. Confirm Wrangler config supports binary imports; if not, fall
back to embedding bytes as a hex string in the generated TS module.)

- `apps/frieren/package.json` — prepend the script to the `build`:

```json
"build": "bun scripts/build-vendor.ts && bun scripts/build-builtins.ts && tsc -b && vite build"
```

- `.gitignore` — ignore `apps/frieren/worker/builtins/*.zip` and
  `*.meta.json` and `index.ts`. They are build artifacts.

**Verify:**
```sh
pnpm install
pnpm --filter frieren build
ls apps/frieren/worker/builtins/
# expect: index.ts, app.frieren.paint.zip, app.frieren.paint.meta.json, …
```

## Step 3.3 — `ensureBuiltinsInstalled(kernel)` on DO boot

**Files:**

- `apps/frieren/worker/frieren.app.ts`:
  - Import `BUILTINS` from `./builtins`.
  - Add `ensureBuiltinsInstalled(kernel)`:

```ts
let builtinsReady: Promise<void> | undefined
async function ensureBuiltinsInstalled(kernel: Kernel) {
  if (builtinsReady) return builtinsReady
  builtinsReady = (async () => {
    const installed = new Map((await kernel.list()).map((m) => [m.id, m.version]))
    for (const b of BUILTINS) {
      if (installed.get(b.id) === b.version) continue // happy path
      await kernel.install(bundleFromZip(b.bytes))
    }
  })()
  return builtinsReady
}
```

  - Call it from `getKernel()` after construction — but lazily: the call
    is awaited at the start of `list()`, `dispatch()`, `state()`,
    `actions()`, `app()`. The `builtinsReady` promise memoizes the work
    per DO instance, so steady-state cost is one promise check.

**Verify:**
- On a fresh user, the first `kernel.list()` returns all built-ins with
  correct versions.
- Bump a built-in's `version` in its `package.json`, rebuild, redeploy:
  next DO boot reinstalls only that one. Confirm via volume inspection
  that other built-ins' install timestamps are unchanged.
- On warm DO (already-installed, current versions): `kernel.list()`
  measures one Volume read (the install loop short-circuits). No
  unnecessary writes.

---

# Part 4 — Migrate Paint

Smallest migration; only needs `volume`. Use this to shake out the
build pipeline and the new mount path.

## Step 4.1 — Scaffold `packages/app-frieren-paint/`

**Files:**

- `packages/app-frieren-paint/package.json` — workspace deps:
  `@justfiles/app`, `@justfiles/app/capabilities/volume`, `react`,
  `react-dom`, `valibot`. Build script: `vite build`.
- `packages/app-frieren-paint/vite.config.ts` — `kernelHost({ id: 'app.frieren.paint', name: 'Paint', description: 'Pixel drawing', icon: 'icon.svg', app: 'src/app.ts', gui: 'src/gui.tsx' })`.
- `packages/app-frieren-paint/public/icon.svg` — copied from existing
  `apps/frieren/src/builtin/paint-icon.svg`.

## Step 4.2 — Reducer (`src/app.ts`)

State:

```ts
{
  tool: 'pencil' | 'eraser' | 'fill' | 'line' | 'rect' | 'ellipse'
  size: 1 | 2 | 4 | 8
  color: string
  lastSavedPath: string | null
  lastError: string | null
}
```

Actions: `setTool({tool})`, `setSize({size})`, `setColor({color})`,
`save({ filename?: string })`, `clearStatus()`.

Capability: `volume({ scopes: ['system'] })` (writes to `/Paint/`).

The `save` handler reads `bytes` from the GUI (passed in via action
params — Paint's canvas pixels stay in the DOM, not in state), writes
to `/Paint/untitled-<timestamp>.png` via `ctx.capabilities.volume.writeFile`.

**Note:** the action params for `save` includes a `pngBytes: Uint8Array`
or base64 string. Valibot schema validates length only. This is the
"semantic state stays in reducer, bitmap stays out" rule.

## Step 4.3 — GUI (`src/gui.tsx`)

Port the existing `PaintApp.tsx`, with these changes:

- Reads `state.tool/size/color` from the kernel state; dispatches setters
  on toolbar interaction.
- On save: serializes the canvas via `toPNG`, calls
  `client.save({ pngBytes })`.
- Undo/redo history stays in a GUI-local ref (transient).
- Replace `@/components/ui/button` and `@/lib/utils` imports with local
  equivalents or plain Tailwind elements; don't add new shared deps.

Use `defineGUI` (the existing one — React mount happens inside the
mount callback via `createRoot`, as `app-crossword` already does).

## Step 4.4 — Wire into builtins registry

**Files:**

- `apps/frieren/scripts/build-builtins.ts` — add Paint to the package
  list.
- `apps/frieren/worker/builtins/index.ts` — regenerates to include Paint.

**Verify:**
```sh
pnpm --filter frieren build
cd apps/frieren && bun run dev
# in another shell:
bun run verify:ui
# launch Paint from the desktop, draw, save, verify file exists at /Paint/...
# also test agent path:
# in the chat: "app run app.frieren.paint setColor color=#ff0000"
# in the chat: "app run app.frieren.paint save pngBytes=..."  (manual harness)
```

## Step 4.5 — Remove the old built-in Paint

After verifying parity, delete:

- `apps/frieren/src/builtin/paint/` (whole directory).
- The `paint` entry in `apps/frieren/src/builtin/index.tsx`'s
  `BUILTIN_APPS` array.

Paint now flows through `KernelAppFrame` like any other app.

---

# Part 5 — Migrate Finder

Exercises `volume{scope:'system'}`.

## Step 5.1 — Scaffold `packages/app-frieren-finder/`

Same shape as Paint. Capability: `volume({ scopes: ['system'] })`.

## Step 5.2 — Reducer

State:

```ts
{
  selectedPath: string | null
  preview: { path: string; content: string } | null
  files: Array<{ path: string }>
  loading: boolean
  error: string | null
}
```

Actions:

- `refresh()` — runs `ctx.capabilities.volume.scan('/')`, returns
  `{ files, loading: false }`.
- `select({ path })` — sets `selectedPath`, reads
  `ctx.capabilities.volume.readFile({ path })`, stores in `preview`.
- `clear()` — `selectedPath: null, preview: null`.

## Step 5.3 — GUI

Port `FinderApp.tsx`. Renders from `state.files` and `state.preview`. On
mount, GUI dispatches `refresh()` if files are empty.

## Step 5.4 — Wire into builtins, verify, delete old

Same flow as Paint. After verify, delete
`apps/frieren/src/builtin/FinderApp.tsx` and its registry entry.

**Verify:**
```sh
bun run verify:ui
# open Finder, click a file, verify preview
# in chat: "app run app.frieren.finder select path=/notes/x.md"
# response should include the file contents (via state read)
```

---

# Part 6 — Migrate Settings

Exercises `integrations` capability.

## Step 6.1 — Scaffold `packages/app-frieren-settings/`

Capability: `integrations({})`. No volume access.

## Step 6.2 — Reducer

State:

```ts
{
  items: IntegrationDescriptor[]
  loading: boolean
  error: string | null
  busy: { id: string; accountId: string } | null
}
```

Actions: `refresh()`, `connect({ id, accountId, credentials })`,
`disconnect({ id, accountId })`.

All host calls go through `ctx.capabilities.integrations.*`.

## Step 6.3 — GUI

Port `SettingsApp.tsx`. Forms dispatch `connect`/`disconnect`. On mount,
dispatch `refresh()` if items empty.

## Step 6.4 — Wire, verify, delete old

Same flow. After verify, delete `apps/frieren/src/builtin/SettingsApp.tsx`.

**Verify:**
```sh
bun run verify:ui
# open Settings, connect/disconnect an integration
# in chat: "app run app.frieren.settings refresh"
# in chat: "app actions app.frieren.settings"  → lists connect/disconnect/refresh with schemas
```

---

# Part 7 — Subscription extension to capabilities

Goal: capabilities can push events to the app reducer (and by extension
to the GUI). Required for `agent` (message stream, tool calls,
streaming). Also useful long-term for `volume` change-notify,
`integrations` auth-state, etc.

## Step 7.1 — Design the wire protocol

Add two action types to the capability invocation wire (currently
`Promise<unknown>`-shaped):

```ts
// existing: one-shot request/response
type CapInvoke = { capability: string; method: string; input: unknown; actor?: string }

// new: long-lived subscription. Returns a subscription id; events come back
// on the same WS as new frames keyed by sub id.
type CapSubscribe = { capability: string; method: string; input: unknown; subId: string; actor?: string }
type CapUnsubscribe = { subId: string }
```

WS server → client adds:

```ts
{ type: 'capability_event'; subId: string; event: unknown }
```

The kernel routes events to whichever app initiated the subscription; the
app's reducer receives them via an auto-dispatched synthetic action.

## Step 7.2 — Reducer-side ergonomics

Two viable shapes; pick one in this step before implementing.

**Option A — synthetic action dispatch.** When a subscription event
arrives, the kernel dispatches an action `__capability/<capId>/<method>`
with the event as params. The app's `defineApp` accepts handlers for
these synthetic actions like any other handler.

**Option B — out-of-band event channel.** Subscriptions return an
async iterator passed into the app's `init` or a new `mount` lifecycle.
App author calls `ctx.setState(...)` from inside the iterator.

Recommendation: **Option A.** It keeps the reducer model pure (every
state change is a dispatched action with a schema) and means the agent
can introspect subscription-driven actions the same way as user-driven
ones.

## Step 7.3 — Implement in `packages/app`

**Files:**

- `packages/app/app.ts` — extend `RuntimeContext` with
  `capabilitySubscribe?: (req: CapSubscribe) => Promise<void>` and
  `capabilityUnsubscribe?: (subId: string) => Promise<void>`.
- `packages/app/sdk.ts` — extend the capability proxy to expose
  `.subscribe(input, handler)` methods (where the capability contract
  declares them as subscribable). Type-level: a method returning
  `AsyncIterable<E>` in the contract becomes subscribable.
- `packages/app/kernel.ts` — kernel emits an `app.update` after each
  synthetic-action dispatch, same as regular dispatches.

## Step 7.4 — Implement in `apps/frieren/worker/frieren.app.ts`

- Track subscriptions per WS in the DO storage (or in-memory; design
  decision: how to survive DO hibernation. Punt to in-memory for v1
  with a note).
- On `capability_event`, route through `kernel.dispatch` with the
  synthetic action shape so the app's reducer processes it.

**Verify:**
- Unit test: a test app declaring a `subscribable` capability method
  receives events as dispatched actions; state updates reflect them.

---

# Part 8 — Migrate Messages

Capability: `agent({ scopes: [] })`.

## Step 8.1 — Define `agent` capability

**Files:**

- New: `packages/app/capabilities/agent/contract.ts`:

```ts
export interface AgentEvent {
  type: 'message_start' | 'message_chunk' | 'message_done' | 'tool_call' | 'tool_result' | 'thinking' | 'error'
  // discriminated union; concrete fields per type
}

export interface AgentCapability {
  send(input: { text: string }): Promise<void>
  abort(input: {}): Promise<void>
  messages(input: { limit?: number }): Promise<ChatMessage[]>
  // subscribable
  events(input: {}): AsyncIterable<AgentEvent>
}
```

- New: `packages/app/capabilities/agent/index.ts` — factory.
- `apps/frieren/worker/frieren.app.ts` — `invokeCapability` for `agent.*`
  delegates to existing `session.manager` + `llm.agent` machinery.
  `events` subscription routes through the new subscription wire.

## Step 8.2 — Scaffold `packages/app-frieren-messages/`

Capability: `agent`.

## Step 8.3 — Reducer

State:

```ts
{
  input: string
  messages: ChatMessage[]      // built up via subscription events
  streaming: boolean
  agentName: string
  userName: string
  lastError: string | null
}
```

Actions:

- `setInput({ value })`.
- `send()` — calls `ctx.capabilities.agent.send({ text: state.input })`,
  clears `input`.
- `abort()` — calls `ctx.capabilities.agent.abort({})`.
- `__capability/agent/events` (synthetic) — receives an `AgentEvent` and
  folds it into the `messages` array / `streaming` flag.

On app launch, the kernel auto-subscribes to `agent.events` (declared
in the app's capability spec as `autoSubscribe: true`, or the GUI
dispatches an explicit `subscribe` action — design decision in step 7.2).

## Step 8.4 — GUI

Port `MessagesApp.tsx`. Renders from `state.messages`; dispatches
`setInput`/`send`/`abort`. Drop the direct `useChatSession` dependency.

The host React shell can keep `useChatSession` for its own purposes
(connection state for the launcher, etc.); the kernel app no longer
needs it.

## Step 8.5 — Wire, verify, delete old

Verify thoroughly — Messages is the most coupled migration.

**Verify:**
```sh
bun run verify:ui
# open Messages, send a message, see streaming response
# kill connection mid-stream, reconnect, verify state restored
# in chat: "app run app.frieren.messages send text=hello"
# (the agent calls itself via the same door — confirm it doesn't loop)
```

---

# Part 9 — Cleanup

Goal: erase every trace of the two-track architecture.

## Step 9.1 — Delete `BuiltinHost.tsx`

**Files:**

- Delete `apps/frieren/src/BuiltinHost.tsx`.
- `apps/frieren/src/ChatPage.tsx` — replace the `app.kind === 'builtin'`
  branch with a single `<KernelAppFrame id={app.id} ... />`.

## Step 9.2 — Drop the `kind` discriminator

**Files:**

- `apps/frieren/src/chat/types.ts` — remove `kind: 'builtin' | 'app'`
  from `InstalledApp` and `ActiveApp`. All apps are kernel apps.
- `apps/frieren/src/chat/useChat.ts` — remove `kind: 'builtin'` from any
  hardcoded references.
- `apps/frieren/worker/frieren.app.ts` — `list()` no longer marks
  `kind`; the discriminator is gone.

## Step 9.3 — Delete the old builtin module

**Files:**

- Delete `apps/frieren/src/builtin/` (entire directory). All apps now
  live in their own packages.
- `apps/frieren/src/ChatPage.tsx` — remove the
  `builtinLauncherEntries()` call; `launcher.installedApps` already
  contains everything.

## Step 9.4 — Update SDK exports if needed

**Files:**

- `packages/app/index.ts` and `packages/app/capabilities/index.ts` —
  ensure all new capability barrels are exported.

## Step 9.5 — Full verification

```sh
pnpm format
pnpm typecheck
pnpm lint:fix
pnpm test
cd apps/frieren && bun run dev
bun run verify:ui
# manual: open and exercise each of the 4 apps
# manual: install a third-party app via the existing dev flow; verify it works alongside built-ins
# manual: agent path — "app list" returns all 4 built-ins + any installed; agent can drive each
```

---

# Open decisions to resolve before starting

1. **Step 1.2:** check in `apps/frieren/public/vendor/` or generate on
   install? Recommendation: generate, ignore in git.
2. **Step 3.2:** binary `.zip` imports via Wrangler — confirm this works
   in the current Wrangler/Vite setup before committing. Fallback: emit
   bytes as a base64 string in the generated TS module.
3. **Step 7.2:** synthetic-action subscription model (Option A) vs
   out-of-band event channel (Option B). Plan assumes A; revisit when
   actually writing the SDK code.
4. **Step 7.4:** subscription state across DO hibernation. v1: in-memory
   only; subscriptions re-established on reconnect. Acceptable?
5. **Whether to commit per-builtin packages under `packages/app-frieren-*`
   or co-locate them under `apps/frieren/builtins/*`.** Recommendation:
   `packages/` for symmetry with `app-counter`/`app-crossword`/`app-doom`.

# Out of scope

- Service-worker caching for `gui.js` (Step 1.6 footnote).
- Delta-push for kernel state updates (Part 7 scope is capability
  events, not state delta encoding).
- Collaborative bitmap/document apps (the "Paint with agent" sketch
  from the design discussion).
- Third-party app trust model beyond "trusted means on host allowlist."

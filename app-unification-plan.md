# App Unification Migration Plan

End state: a single, sandboxed kernel-app architecture for **applications**
(Finder, Paint, Settings). Each is a kernel app with the same shape as any
third-party app, differentiated only by which capabilities the host grants
it. Built-ins ship with the worker, install themselves into the user's
volume on first launch, and update in place when their version changes.

**The agent (and its chat surface, today called "Messages") is OS-level,
not an app.** Like Siri or Spotlight, it's invoked from the OS shell rather
than launched from a desktop icon. The host's React shell owns the chat
window; a menubar entry opens/closes it. The agent has god-mode access
(LLM client, tools, all kernel-app actions); sandboxing it makes no sense.

## Architecture target

- One dispatch path in the kernel for *apps* (the sandboxed Worker Loader
  path). No trusted/in-process branch.
- One mount path in the browser for *apps* (`KernelAppFrame`). No
  `BuiltinHost`.
- One launcher entry shape (`{ id, name, description, iconUrl, version }`)
  for apps. No `kind: 'builtin' | 'app'` distinction at the UI layer.
- The chat window is OS chrome, not in the launcher. A menubar button
  opens it.
- React, ReactDOM, and JSX runtime are shared across host and all apps via
  an import map. Apps externalize React in their bundle.
- Capability contracts (`volume{scope}`, `integrations`, and the kernel
  notification center for events) cover the host services apps need.
- Filesystem access is exposed through the `volume` capability. The current
  ambient `ctx.files` injection is transitional only and should disappear
  after apps have migrated to `ctx.capabilities.volume`.
- Built-in app bundles live as zipped assets in the worker. On DO boot,
  `ensureBuiltinsInstalled(kernel)` compares versions and reinstalls any
  that are missing or outdated. Near-zero cost on the happy path.
- The kernel is the notification center: capability impls call
  `kernel.emit(channel, event)`; apps declare reducer handlers via the
  typed `on` block in `defineApp`. No per-capability subscription
  bookkeeping.

## Sequencing

Each part depends on the previous. Within a part, steps are ordered.

1. **Shared React runtime infrastructure.** Unblocks every app using React.
2. **New capabilities** (`volume{scope}`, `integrations`) for migrating
   Finder/Paint/Settings.
3. **Built-in install pipeline.** Worker ships bundles, installs on boot.
4. **Migrate Paint** (smallest; exercises the pipeline end-to-end).
5. **Migrate Finder** (exercises `volume{scope:'system'}`).
6. **Migrate Settings** (exercises `integrations`).
7. **Kernel as notification center.** Typed capability events,
   declarative `on`-handlers, `kernel.emit`. Used by `volume.watch`,
   integrations auth state, and (future) the agent.
8. **Demote Messages to OS chrome.** Strip the app pretense from the
   existing `Messages` built-in: remove icon, remove launcher entry,
   add a menubar button that opens the same window. The chat surface
   stays in `apps/frieren/src/` where the session manager already lives.
9. **Cleanup.** Delete `BuiltinHost`, drop the old builtin-apps table,
   remove the `kind` discriminator for apps. The menubar chat is not
   an app, so it does not flow through `KernelAppFrame`.

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
- `apps/frieren/package.json` — prepend `node scripts/build-vendor.ts` to
  the `build` script (and to `dev` via a `prebuild` step or one-time
  manual run; the outputs check into `public/` so dev works immediately).
- `.gitignore` — keep `public/vendor/` ignored or check it in; pick one
  and document. Recommendation: ignore; emit on `pnpm install`
  postinstall and on `build`.

**Verify:**
```sh
cd apps/frieren && node scripts/build-vendor.ts
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
cd apps/frieren && pnpm run dev
# in another shell:
pnpm run verify:ui
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
yet. This is also the start of retiring ambient filesystem access:
`ctx.files` remains only as compatibility scaffolding until existing apps
move to `ctx.capabilities.volume`.

## Step 2.1 — `volume` capability becomes the filesystem API

`ctx.files` already gives apps a per-app chroot today, but it is ambient:
apps do not declare it, the host cannot grant narrower/broader access via
the same mechanism as other services, and the agent cannot see that the app
needs filesystem access. Keep the default behavior for compatibility, but
make `volume` the explicit API all migrated apps use.

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
  `scopes` already; document that `'app'`/missing means the existing
  per-app chroot, `'system'` means root-volume access (host enforces),
  and path-like scope strings mean specific path prefixes.

- `packages/app/app.ts` / `packages/app/sdk.ts` — include the requested
  capability scopes in `CapabilityInvocation` so the host can enforce the
  declared grant. Do not remove `files` yet; mark it as deprecated or
  internal transitional plumbing.

- `apps/frieren/worker/frieren.app.ts` — extend `invokeCapability` with
  a `volume` branch. Use the app's requested scopes to decide what volume
  to hand back: `'system'` → host fs; specific prefix → `chroot(fs,
  prefix)`; `'app'`/missing → existing per-app `chroot` at
  `/applications/:id/data/files`.

**Verify:**
- Existing apps unaffected while they still use `ctx.files`.
- An app declaring `volume({ scopes: ['app'] })` can read/write only its
  `/applications/:id/data/files` tree.
- Unit test: a trusted sandboxed app declaring `volume({ scopes: ['system'] })`
  can read a file outside its own `data/files` dir.
- Unit test: an app without a matching grant cannot use `system` volume access.

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

Each built-in lives in its own `packages/app-<name>/` directory,
with `package.json#version` as the source of truth.

**Files (new packages — created in Parts 4–8):**

- `packages/app-finder/`
- `packages/app-paint/`
- `packages/app-settings/`
- `packages/app-messages/`

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
"build": "node scripts/build-vendor.ts && node scripts/build-builtins.ts && tsc -b && vite build"
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

## Step 4.1 — Scaffold `packages/app-paint/`

**Files:**

- `packages/app-paint/package.json` — workspace deps:
  `@justfiles/app`, `@justfiles/app/capabilities/volume`, `react`,
  `react-dom`, `valibot`. Build script: `vite build`.
- `packages/app-paint/vite.config.ts` — `kernelHost({ id: 'app.frieren.paint', name: 'Paint', description: 'Pixel drawing', icon: 'icon.svg', app: 'src/app.ts', gui: 'src/gui.tsx' })`.
- `packages/app-paint/public/icon.svg` — copied from existing
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
cd apps/frieren && pnpm run dev
# in another shell:
pnpm run verify:ui
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

## Step 5.1 — Scaffold `packages/app-finder/`

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
pnpm run verify:ui
# open Finder, click a file, verify preview
# in chat: "app run app.frieren.finder select path=/notes/x.md"
# response should include the file contents (via state read)
```

---

# Part 6 — Migrate Settings

Exercises `integrations` capability.

## Step 6.1 — Scaffold `packages/app-settings/`

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
pnpm run verify:ui
# open Settings, connect/disconnect an integration
# in chat: "app run app.frieren.settings refresh"
# in chat: "app actions app.frieren.settings"  → lists connect/disconnect/refresh with schemas
```

---

# Part 7 — Kernel as notification center  *(shipped)*

Goal: capabilities emit named events; apps declare reducer handlers for
them via a typed `on` block; the kernel routes. One mechanism for
`volume` change-notify, `integrations` auth-state, future kernel-level
event sources, and (when needed) agent observation by other apps.

**Mental model.** Capabilities have two halves of their contract: the
`Methods` interface (request/response — what the app calls) and the
optional `Events` interface (named pushes — what the app reacts to).
The reducer is a function from `(state, action | event) → state`;
`actions` are user/agent-driven inputs, `on` is system-driven inputs.
Both go through the same dispatch path so every state change is
auditable and `app.update` fires for both.

**Why kernel-mediated, not per-capability:** capability impls only
declare *what* their events are and *when* they fire. They never
manage routing, subscription bookkeeping, or fan-out — the kernel
does all of that.

## Step 7.1 — Contracts: events join `defineCapability`

`defineCapability` gains a third type generic for events. Backwards-
compatible: capabilities that don't emit don't pass it.

```ts
// packages/app/capabilities/agent/contract.ts
export interface AgentMethods {
	send(input: { text: string }): Promise<void>
	abort(input: {}): Promise<void>
}
export interface AgentEvents {
	message: { id: string; role: 'user' | 'assistant'; text: string }
	chunk:   { messageId: string; delta: string }
	done:    { messageId: string }
}
export const agent = defineCapability<'agent', AgentMethods, AgentEvents>('agent')
```

The factory's return type carries `__methods` and `__events` phantoms
so the app's `defineApp` can extract them.

## Step 7.2 — Reducer-side ergonomics: declarative `on`

`defineApp` takes an `on` block, keyed by capability name → event
name. Both levels optional; payload type flows from the contract.

```ts
defineApp({
	init: { messages: [], streaming: false },
	capabilities: { agent: agent({ scopes: [] }) },
	actions: (b) => ({
		send: b.handler({
			schema: v.object({ text: v.string() }),
			async handler({ text }, ctx) {
				await ctx.capabilities.agent.send({ text })
				return ctx.state
			}
		})
	}),
	on: {
		agent: {
			message: (event, ctx) => ({ ...ctx.state, messages: [...ctx.state.messages, event] }),
			chunk:   ({ messageId, delta }, ctx) => ({ ...ctx.state, streaming: true, messages: appendDelta(ctx.state.messages, messageId, delta) }),
			done:    (_, ctx) => ({ ...ctx.state, streaming: false })
		}
	}
})
```

No builder. No `subscribe(method, input)` call. No subId. The app
declares what it cares about; the kernel does the rest.

Under the hood, `on` handlers register as actions under the key
`__event/<capId>.<eventName>`. Same dispatch path as regular actions
— but excluded from the public `kernel.actions(appId)` view so the
agent doesn't see them as callable.

## Step 7.3 — Kernel-level event router

The kernel exposes one new method:

```ts
interface Kernel {
	// ...
	emit(channel: string, event: unknown): Promise<void>
}
```

Capability impls (host-side) call `kernel.emit('agent.chunk', payload)`.
The kernel:

1. Looks up subscribers from an in-memory channel → app-ids index
   (built lazily by scanning each installed app's `__event/*` action
   keys; updated on install/uninstall).
2. Dispatches a synthetic action `__event/<channel>` with the payload
   into each subscriber app. Errors from one subscriber are swallowed
   so a broken handler can't stop fan-out.
3. The normal dispatch path persists state and emits `app.update`.

**Files:**

- `packages/app/capabilities/core.ts` — `defineCapability` gains
  `Events` generic.
- `packages/app/app.ts` — `OnHandlers` type; `EventsOf<C>` extractor;
  `CapabilityRequest` accepts the third generic.
- `packages/app/sdk.ts` — `EVENT_ACTION_PREFIX` constant; `defineApp`
  accepts `on`; merges into the action table; keeps event keys in
  the sandbox-visible meta (kernel filters at the public API).
- `packages/app/kernel.ts` — `emit`, subscription index, public
  `actions(appId)` filters out `__event/*`.
- `packages/app/index.ts` — export updated types.

## Step 7.4 — Frieren worker plumbing

The worker side is now trivial: capability impls call
`getKernel().emit(channel, event)` when their underlying source
fires. No per-WS subscription tracking, no sandbox-side
subscribe/unsubscribe RPC, no client wire-protocol changes.

When a capability eventually needs to push (volume change-notify is
the canonical near-term example), the impl shape is just:

```ts
async function invokeCapability(req) {
	if (req.capability === 'volume' && req.method === 'writeFile') {
		await vol.writeFile(req.input.path, req.input.data)
		void getKernel().emit('volume.changed', { path: req.input.path, type: 'modify' })
		return
	}
	// ...
}
```

Apps that care declare `on: { volume: { changed: (e, ctx) => ... } }`
and react. No subscribe calls, no subIds.

**Verify:**

- Unit tests (`packages/app/event.test.ts`):
  - `kernel.emit` fans events to apps declaring matching `on` handlers.
  - Event handlers are not exposed in `kernel.actions(appId)`.
  - Emit on channels with no subscribers is a no-op.
  - Multi-app fan-out lands in every subscriber.
  - Uninstall removes apps from the subscription index.

---

# Part 8 — Demote Messages to OS chrome

Messages stops pretending to be an app: no icon, no launcher tile, no
`KernelAppFrame`. The same React component renders, but it's invoked
from the OS shell (a menubar button) and lives outside the app
abstraction entirely — like Spotlight or Siri, not like Notes.

The chat surface keeps living in `apps/frieren/src/` where it already
is, alongside `session.manager`, `llm.agent`, and the rest of the
agent machinery. No code moves into `packages/`. No `agent` capability
gets built (deferred until a kernel app actually needs to talk to the
agent — none do today).

## Step 8.1 — Remove Messages from the app catalog

**Files:**

- `apps/frieren/src/builtin/index.tsx` — delete the `messages` entry
  from `BUILTIN_APPS`. The file may then be left empty / removed
  entirely if nothing else lives there; the next migration (Part 9
  cleanup) will tear down `BUILTIN_APPS` and `builtinLauncherEntries`
  altogether anyway, so it's fine to leave the array empty for now.
- `apps/frieren/src/ChatPage.tsx` — when iterating launcher entries,
  Messages no longer shows up; verify there's no special-cased
  `id === 'messages'` branch left behind.

After this step the launcher's desktop grid has Paint, Finder,
Settings (post-migration) and any third-party installs — no Messages.

## Step 8.2 — Add a menubar entry that opens the chat

**Files:**

- `apps/frieren/src/ChatPage.tsx` (or wherever the menubar/topbar lives
  in the current shell) — add a button labelled "Messages" (or just an
  agent icon) that toggles a `chatOpen` state in the page-level
  component. Default closed on fresh sessions; persist the last-open
  state per user if cheap.
- When `chatOpen`, render the existing `MessagesApp` component in
  whatever window/overlay shape we want today. For v1, keep the
  same window/dialog the current built-in opens into — just sourced
  from the menubar instead of the desktop grid.
- The component imports stay where they are; no path changes for
  `MessagesApp.tsx` itself in this step.

The point of this step is purely *invocation surface*: the chat is no
longer "an app you launch," it's "the assistant you toggle." Visual
polish (overlay, sidebar, keyboard shortcut, spotlight-style command
bar) is future work.

## Step 8.3 — Make the chat surface independent of the app frame

**Files:**

- `apps/frieren/src/builtin/MessagesApp.tsx` — move out of the
  `builtin/` directory (since it isn't a built-in app any more).
  Suggested new home: `apps/frieren/src/chat/MessagesPanel.tsx`
  alongside `useChatSession`. Rename to `MessagesPanel` to make the
  not-an-app status obvious in imports.
- Update all references to point to the new path.
- The component continues to use `useChatSession` directly — that's
  the *correct* coupling now that the chat surface is OS-level.
- Drop any code that was added to make the component behave like a
  kernel app (mount/unmount lifecycle hooks expected by
  `BuiltinHost`, manifest-style props, etc.).

## Step 8.4 — Verify

```sh
cd apps/frieren && pnpm run dev
# in another shell:
pnpm run verify:ui
# manual:
#   - desktop grid no longer shows a Messages icon
#   - menubar shows the agent button
#   - clicking it opens the chat window
#   - sending a message works exactly as before (streaming, tools)
#   - closing/reopening preserves the conversation
```

## Step 8.5 — Future: when (if) a kernel app needs the agent

If/when a kernel app does want to integrate with the agent (e.g., a
Tasks app that wants to react to `agent.tool_call` events), build the
`agent` capability *then*. The notification center (Part 7) makes that
addition a small contained change — declare `AgentEvents` in the
contract, have `session.manager` call `kernel.emit('agent.tool_call',
…)`, done. Until then, no point shipping an unused capability.

---

# Part 9 — Cleanup

Goal: erase every trace of the two-track architecture for apps. The
menubar chat surface is *not* part of this — it lives outside the
app abstraction by design.

## Step 9.1 — Delete `BuiltinHost.tsx`

By the time we get here, Paint/Finder/Settings are kernel apps and
Messages is OS chrome — no caller mounts a built-in app frame any more.

**Files:**

- Delete `apps/frieren/src/BuiltinHost.tsx`.
- `apps/frieren/src/ChatPage.tsx` — remove the `app.kind === 'builtin'`
  branch; every launcher entry is a kernel app and mounts via
  `<KernelAppFrame id={app.id} ... />`.

## Step 9.2 — Drop the `kind` discriminator

**Files:**

- `apps/frieren/src/chat/types.ts` — remove `kind: 'builtin' | 'app'`
  from `InstalledApp` and `ActiveApp`. All launcher entries are kernel
  apps.
- `apps/frieren/src/chat/useChat.ts` — remove `kind: 'builtin'` from any
  hardcoded references.
- `apps/frieren/worker/frieren.app.ts` — `list()` no longer marks
  `kind`; the discriminator is gone.

## Step 9.3 — Delete the old builtin-apps module

**Files:**

- Delete `apps/frieren/src/builtin/` (entire directory — Messages
  moved out in Part 8 to `apps/frieren/src/chat/MessagesPanel.tsx`,
  Paint/Finder/Settings live in their own packages).
- `apps/frieren/src/ChatPage.tsx` — remove the
  `builtinLauncherEntries()` call; `launcher.installedApps` already
  contains everything.

## Step 9.4 — Remove legacy `ctx.files`

After Paint/Finder/Settings and the sample apps use
`ctx.capabilities.volume`, delete the old ambient filesystem injection.

**Files:**

- `packages/app/app.ts` — remove `files` from `Context` and
  `RuntimeContext`.
- `packages/app/kernel.ts` — stop passing `chroot(fs,
  /applications/:id/data/files)` as `ctx.files`; that chroot is now only
  selected inside the `volume` capability implementation for `'app'` scope.
- `apps/frieren/worker/kernel.sandbox.ts` — update comments/transport
  assumptions so only state, `setState`, and capability invocation cross
  into the sandbox.

## Step 9.5 — Update SDK exports if needed

**Files:**

- `packages/app/index.ts` and `packages/app/capabilities/index.ts` —
  ensure all new capability barrels are exported.

## Step 9.6 — Full verification

```sh
pnpm format
pnpm typecheck
pnpm lint:fix
pnpm test
cd apps/frieren && pnpm run dev
pnpm run verify:ui
# manual: open and exercise each of the 3 kernel apps (Paint, Finder, Settings)
# manual: open the menubar chat — agent works, streams, tool-calls land
# manual: install a third-party app via the existing dev flow; verify it works alongside built-ins
# manual: agent path — "app list" returns the 3 built-ins + any installed; agent can drive each
```

---

# Open decisions

1. **Step 1.2:** check in `apps/frieren/public/vendor/` or generate on
   install? Recommendation: generate, ignore in git.
2. **Step 3.2:** binary `.zip` imports via Wrangler — confirm this works
   in the current Wrangler/Vite setup before committing. Fallback: emit
   bytes as a base64 string in the generated TS module.
3. **Whether to commit per-builtin packages under `packages/app-*`
   or co-locate them under `apps/frieren/builtins/*`.** Recommendation:
   `packages/` for symmetry with `app-counter`/`app-crossword`/`app-doom`.
4. **Menubar chat invocation UX** (Part 8). Toggle button is enough
   for v1; spotlight-style shortcut, persistent presence affordance,
   notifications all come later.

# Resolved decisions

- **Part 7 subscription ergonomics:** kernel-as-notification-center,
  declarative `on` handlers (no per-capability `.subscribe()`). Shipped.
- **Agent capability:** deferred until a kernel app actually needs to
  observe/talk to the agent. The OS-level chat surface (Part 8) does
  not require it — it sits next to `session.manager` directly.
- **Messages as kernel app vs OS chrome:** OS chrome. The agent is OS-
  level, not an app.

# Out of scope

- Service-worker caching for `gui.js` (Step 1.6 footnote).
- Delta-push for kernel state updates (Part 7 scope is capability
  events, not state delta encoding).
- Collaborative bitmap/document apps (the "Paint with agent" sketch
  from the design discussion).
- Third-party app trust model beyond "trusted means on host allowlist."
- Richer agent UX (spotlight-style command bar, contextual awareness
  of focused app, system notifications). Part 8 just changes the
  invocation surface; visual polish is follow-up work.

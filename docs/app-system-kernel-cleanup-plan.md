# App system cleanup plan: make kernel the only app system

> Historical cleanup plan. Legacy app-system references below describe deleted systems and are intentional.

## Context

The current repository has three app-system shapes inside `@justfiles/app`:

1. **Legacy iframe app system**
	- Browser app logic runs in an iframe.
	- App code uses `window.app` from `@justfiles/app/sdk`.
	- Host talks to iframe through JSON-RPC (`AppRpcRequest`, `AppRelay`, `AppHost`).
	- Frieren wiring lives in `apps/frieren/worker/frieren.app.ts`, `apps/frieren/worker/app-rpc.ts`, `apps/frieren/src/AppFrame.tsx`.

2. **Legacy browser-side ESM app system**
	- App logic runs in the browser via remote ESM import.
	- App exports default `{ mount(el, host), unmount() }`.
	- Host injects `Host = { volume, capabilities }`.
	- Frieren wiring lives in `apps/frieren/src/EsmAppFrame.tsx`.

3. **New kernel app system**
	- App logic runs in sandboxed headless `app.js`.
	- Browser `gui.js` is just UI and dispatches typed actions.
	- Kernel owns install, dispatch, state, private files, app assets, action metadata.
	- Frieren runs `app.js` through Worker Loader and loads `gui.js` with `KernelAppFrame`.

The product decision is:

- Drop iframe apps.
- Drop browser-side ESM app logic.
- Keep only the kernel model.
- Eventually make this the root `@justfiles/app` interface, not `@justfiles/app/kernel/*`.
- During the cleanup, code may stay under `packages/app/kernel/`; final move/rename happens last.

## Target model

App authors should eventually write:

```ts
import { defineApp, defineGUI } from '@justfiles/app'
import { ai } from '@justfiles/app/capabilities/ai'
```

not:

```ts
import { defineApp, defineGUI } from '@justfiles/app/kernel/sdk'
import { ai } from '@justfiles/app/capabilities/ai'
```

Conceptually, the package should expose:

```txt
@justfiles/app                  app/kernel SDK + runtime contracts
@justfiles/app/vite             app build plugin
@justfiles/app/capabilities     capability primitives
@justfiles/app/capabilities/ai  capability contracts
```

Internally, this can remain under `packages/app/kernel/` until the last phase.

## Non-goals for this cleanup

- Do not preserve old iframe app compatibility.
- Do not preserve old browser-side ESM app compatibility.
- Do not preserve bundled app registry / `hostApps()`.
- Do not add dispatch serialization as part of the cleanup. It is a real improvement, but not a prerequisite for deletion and not present in legacy either.

---

# Phase 1 — Strengthen the kernel app manifest and asset serving

## Step 1.1 — Add optional metadata to kernel manifest

### What

Extend `packages/app/kernel/app.ts`:

```ts
export interface AppManifest {
	id: string
	name: string
	description?: string
	version?: string
	icon?: string
	app: string
	gui?: string
	cli?: string
}
```

### Why

The legacy manifest had launcher metadata. Kernel manifests currently only provide `id` and `name`, so Frieren shows empty descriptions and no icons for installed app-system apps.

The kernel app system should keep the useful metadata, without preserving legacy permissions or iframe fields.

### How

- Update `AppManifest`.
- Update `MemoryAppBundle` if useful:

```ts
export interface MemoryAppBundle {
	id: string
	name: string
	description?: string
	version?: string
	icon?: string
	app: string
	gui?: string
	cli?: string
	assets?: Record<string, string | Uint8Array>
}
```

- Make `appBundleFromMemory().manifest()` include optional fields.
- Update `kernelHost()` options to accept optional metadata:

```ts
export interface DevServerOptions {
	id: string
	name: string
	description?: string
	version?: string
	icon?: string
	app: string
	gui: string
}
```

- Emit those fields into `dist/manifest.json`.

### Verification

Run:

```sh
pnpm --filter @justfiles/app typecheck
pnpm exec vitest run packages/app/kernel
```

Manual check:

```sh
pnpm --filter @justfiles/app-counter build
cat packages/app-counter/dist/manifest.json
```

Expected manifest can include optional metadata when configured.

---

## Step 1.2 — Add safe path validation for kernel bundle paths

### What

Centralize validation for paths inside an installed app bundle.

Add a helper near `appRoot()` in `packages/app/kernel/kernel.ts` or in `packages/app/kernel/app.ts`:

```ts
function safeBundlePath(path: string): string {
	if (!path || path.includes('\0')) throw new Error(`invalid app bundle path: ${path}`)
	if (path.startsWith('/') || path.startsWith('//')) {
		throw new Error(`invalid app bundle path: ${path}`)
	}
	const parts = path.split('/').filter((part) => part && part !== '.')
	if (parts.length === 0 || parts.some((part) => part === '..')) {
		throw new Error(`invalid app bundle path: ${path}`)
	}
	return parts.join('/')
}
```

### Why

The current manual Frieren install path writes selected files directly to:

```txt
/kernel/applications/<id>/<name>
```

It bypasses `kernel.install()` entirely. Before making kernel the only app system, bundle installation should have one safe path.

### How

Use `safeBundlePath()` in:

- `kernel.install()` for every path from `app.list()`.
- `InstalledApp.read(path)`.
- asset route reads in Frieren before calling `installed.read(path)`.
- manifest fields `app`, `gui`, `cli`, `icon` when present.

Inside `kernel.install()`:

```ts
const appEntry = safeBundlePath(manifest.app)
const guiEntry = manifest.gui ? safeBundlePath(manifest.gui) : undefined
const icon = manifest.icon ? safeBundlePath(manifest.icon) : undefined

for await (const rawPath of app.list()) {
	const path = safeBundlePath(rawPath)
	await fs.writeFile(`${root}/${path}`, await app.read(rawPath))
}
```

Also verify required files exist before returning:

```ts
if (!(await fs.exists(`${root}/${appEntry}`))) throw new Error(`missing app entry: ${appEntry}`)
if (guiEntry && !(await fs.exists(`${root}/${guiEntry}`))) throw new Error(`missing gui entry: ${guiEntry}`)
if (icon && !(await fs.exists(`${root}/${icon}`))) throw new Error(`missing icon: ${icon}`)
```

### Verification

Add tests in `packages/app/kernel/kernel.test.ts`:

- install rejects `../app.js` in manifest entry.
- install rejects listed file path `../evil.js`.
- install rejects missing `app.js`.
- valid app still installs and dispatches.

Run:

```sh
pnpm exec vitest run packages/app/kernel/kernel.test.ts
```

---

## Step 1.3 — Cherry-pick broad MIME support into kernel serving

### What

Use the broader MIME map from old `vite-plugin.ts` / `apps/frieren/worker/index.ts` for kernel app assets.

Target map:

```ts
const MIME: Record<string, string> = {
	html: 'text/html; charset=utf-8',
	js: 'application/javascript; charset=utf-8',
	mjs: 'application/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	json: 'application/json; charset=utf-8',
	svg: 'image/svg+xml',
	wasm: 'application/wasm',
	wad: 'application/octet-stream',
	cfg: 'text/plain; charset=utf-8',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp'
}
```

### Why

Kernel apps already serve JS/WASM/WAD/CFG. Icons and future app assets need SVG/PNG/CSS/etc. The legacy app path had this coverage.

### How

Update MIME helpers in:

- `packages/app/kernel/dev-server.ts`
- `apps/frieren/worker/frieren.ts` kernel asset route

Keep it minimal: duplicate the map or place it in one kernel utility if that stays simple.

### Verification

- Build app-doom and app-crossword.
- Install them.
- Verify `/api/kernel/<id>/icon.svg` responds with `image/svg+xml`.
- Verify `/api/kernel/<id>/doom.wasm` still responds with `application/wasm`.

Run:

```sh
pnpm typecheck
pnpm test
```

---

## Step 1.4 — Add recursive asset collection where kernel builds/installs bundles

### What

Cherry-pick the old recursive walker idea.

Node side:

```ts
function* walkFiles(dir: string, prefix = ''): Iterable<string> {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name)
		const rel = prefix ? join(prefix, name) : name
		const stat = statSync(full)
		if (stat.isDirectory()) yield* walkFiles(full, rel)
		else if (stat.isFile()) yield rel
	}
}
```

Browser directory picker side:

```ts
async function* walkDirectory(
	dir: FileSystemDirectoryHandle,
	prefix = ''
): AsyncIterable<{ path: string; file: File }> {
	for await (const [name, handle] of dir.entries()) {
		const path = prefix ? `${prefix}/${name}` : name
		if (handle.kind === 'file') yield { path, file: await handle.getFile() }
		else yield* walkDirectory(handle, path)
	}
}
```

### Why

Old `hostApps()` supported nested assets. Current kernel dev/install paths mostly handle top-level files. Vite/Rollup assets can become nested later.

### How

- Update `packages/app/kernel/dev-server.ts` `publicAssets()` to recurse.
- Later, when replacing direct browser volume writes with a proper install endpoint, use recursive directory collection there too.

### Verification

Add a nested public asset fixture or quick test around the helper.

Manual:

```txt
packages/app-doom/public/nested/example.txt
```

Build/dev install and verify it can be read from the kernel app asset route.

---

# Phase 2 — Route app installation through the kernel

## Step 2.1 — Add a real Frieren install endpoint for kernel app bundles

### What

Replace browser-side direct writes to `/kernel/applications/<id>` with a worker/DO endpoint that calls `kernel.install()`.

Suggested route:

```txt
POST /api/apps/install
```

Request body can be JSON first for simplicity:

```ts
type InstallAppRequest = {
	files: Array<{
		path: string
		bytes: string // base64
	}>
}
```

### Why

The kernel should own install semantics. Direct volume writes bypass validation and make it easy for browser install, future drag/drop, and future zip upload to diverge.

### How

In Frieren DO, add a handler that:

1. parses files,
2. validates paths with kernel-safe path rules,
3. creates an `AppBundle`,
4. calls `await (await this.kernel()).install(bundle)`,
5. returns installed manifest/list result.

Sketch:

```ts
function bundleFromUploadedFiles(files: UploadedFile[]): AppBundle {
	const map = new Map(files.map((file) => [safeBundlePath(file.path), decodeBase64(file.bytes)]))
	return {
		async manifest() {
			const bytes = map.get('manifest.json')
			if (!bytes) throw new Error('missing manifest.json')
			return JSON.parse(new TextDecoder().decode(bytes)) as AppManifest
		},
		async *list() {
			yield* map.keys()
		},
		async read(path) {
			const bytes = map.get(safeBundlePath(path))
			if (!bytes) throw new Error(`file not found: ${path}`)
			return bytes
		}
	}
}
```

Browser `installKernelAppOnce()` changes from direct volume writes to:

```ts
const files = []
for await (const { path, file } of walkDirectory(dir)) {
	files.push({ path, bytes: base64(new Uint8Array(await file.arrayBuffer())) })
}
await fetch('/api/apps/install', {
	method: 'POST',
	headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
	body: JSON.stringify({ files })
})
```

If using Clerk middleware with cookies is easier in browser, route it like existing authenticated `/api/*` calls.

### Verification

- Install app-counter through the UI.
- Confirm kernel list includes it.
- Launch it.
- Dispatch increment from GUI.
- Confirm files are written under `/kernel/applications/<id>` only by kernel install.

Automated test target:

- a DO/unit-level route test if existing test harness supports it,
- otherwise add coverage at `kernel.install()` and do one manual smoke check.

---

## Step 2.2 — Update uninstall to use a kernel-owned endpoint

### What

Replace direct browser `vol.rm('/kernel/applications/<id>')` with:

```txt
POST /api/apps/uninstall
{ "id": "..." }
```

or:

```txt
DELETE /api/apps/:id
```

### Why

Same reason as install: one app lifecycle path, one place for validation and future cleanup.

### How

DO route:

```ts
await (await this.kernel()).uninstall(id)
```

Browser launcher:

```ts
await fetch(`/api/apps/${encodeURIComponent(id)}`, { method: 'DELETE' })
```

### Verification

- Install app.
- Uninstall it.
- Reconnect.
- Confirm it is absent from launcher.
- Confirm opening old id fails cleanly.

---

# Phase 3 — Collapse Frieren launcher model to builtin + app-system app

## Step 3.1 — Rename active app kind from `kernel` to `app`

### What

Use product language in Frieren UI types:

```ts
type ActiveApp =
	| { kind: 'builtin'; id: string }
	| { kind: 'app'; id: string }

interface InstalledApp {
	id: string
	name: string
	description: string
	iconUrl?: string
	kind: 'builtin' | 'app'
}
```

### Why

`kernel` is an implementation detail. After deletion, app-system apps are just apps. Builtins are not app-system apps.

### How

Move these types into Frieren locally, probably near `apps/frieren/src/chat/types.ts`, instead of importing them from root `@justfiles/app`.

Update:

- `apps/frieren/src/chat/useChat.ts`
- `apps/frieren/src/chat/ShadcnView.tsx`
- `apps/frieren/src/LauncherView.tsx`
- `apps/frieren/src/builtin/index.tsx`
- server message types in `apps/frieren/worker/frieren.ts`

Server message rename can be done now or later. Recommended product-facing names:

```ts
| { type: 'app_open'; id: string }
| { type: 'app_close' }
```

But avoid colliding with legacy old `app_open` until legacy code is deleted. During transition use:

```ts
| { type: 'kernel_app_open'; id: string }
| { type: 'kernel_app_close' }
```

then rename after old paths are gone.

### Verification

Run:

```sh
pnpm --filter @justfiles/frieren typecheck
pnpm test
```

Manual:

- Builtin Settings still launches.
- Installed app launches via `KernelAppFrame`.

---

## Step 3.2 — Use manifest metadata in launcher entries

### What

Map kernel manifests to launcher entries with optional metadata:

```ts
return manifests.map((m) => ({
	id: m.id,
	name: m.name,
	description: m.description ?? '',
	iconUrl: m.icon ? `/api/kernel/${m.id}/${m.icon}` : undefined,
	kind: 'app' as const
}))
```

### Why

Now that kernel manifest has metadata, Frieren should use it.

### Verification

Install an app with `description` and `icon` in manifest. Confirm launcher displays both.

---

# Phase 4 — Delete legacy Frieren app paths

## Step 4.1 — Remove old iframe/ESM UI frames

### What

Delete:

```txt
apps/frieren/src/AppFrame.tsx
apps/frieren/src/EsmAppFrame.tsx
```

Remove branches from `ShadcnView.tsx`:

```tsx
activeApp.kind === 'sandbox'
activeApp.kind === 'esm'
```

Keep only:

```tsx
activeApp.kind === 'builtin'
activeApp.kind === 'app'
```

### Why

Browser-side app logic is intentionally gone.

### Verification

`rg` should find no references:

```sh
rg "AppFrame|EsmAppFrame|kind === 'sandbox'|kind === 'esm'" apps/frieren/src
```

Run:

```sh
pnpm --filter @justfiles/frieren typecheck
```

---

## Step 4.2 — Remove old app JSON-RPC client state from `useChat`

### What

Remove:

- `AppRpcRequest`
- `AppRpcResponse`
- `AppRpcError`
- `AppRelay`
- `ToolInvokeHandler`
- `ToolResultSender`
- pending RPC map
- tool invoke handler ref
- `sendRpc`
- `onToolInvoke`
- `sendToolResult`
- `notifyIframeReload`
- handling of old server messages:
	- `app_rpc`
	- `app_tool_invoke`
- sending old client messages:
	- `app_launch`
	- `app_close`
	- `app_rpc`
	- `app_tool_result`
	- `app_iframe_reload`

### Why

Those exist only for iframe `window.app` JSON-RPC.

### How

`UseChatResult` becomes simpler:

```ts
export interface UseChatResult {
	session: ChatSession
	connection: ChatConnection
	apps: {
		launcher: Launcher
	}
}
```

`Launcher` only has:

```ts
export type Launcher = {
	activeApp: ActiveApp | null
	installedApps: InstalledApp[]
	launch(app: InstalledApp): void
	close(): void
	installApp?: () => Promise<void>
	uninstallApp?: (id: string) => Promise<void>
}
```

### Verification

```sh
rg "app_rpc|app_tool|AppRelay|ToolInvoke|AppRpc" apps/frieren/src
pnpm --filter @justfiles/frieren typecheck
```

Expected: no matches in `apps/frieren/src`, except perhaps historical docs.

---

## Step 4.3 — Remove old Frieren worker app host

### What

Delete:

```txt
apps/frieren/worker/frieren.app.ts
apps/frieren/worker/app-rpc.ts
```

Remove from `apps/frieren/worker/frieren.ts`:

- `FrierenAppHost`
- `listApps` import
- `this.apps`
- `this.apps.clear()`
- `this.apps.rebind()`
- `this.apps.hydrate()`
- `this.apps.handleMessage()`
- `this.apps.handlePromptCommand()`
- `this.apps.openMessage()`
- legacy `capabilityBridge()` if only used by old app host
- legacy server/client message variants

Ready message apps should become:

```ts
apps: [...builtin metadata if needed on client, ...(await this.kernelApps())]
```

or just kernel apps, since builtin entries are already client-local.

### Why

`FrierenAppHost` exists solely to host legacy iframe/static apps.

### Verification

```sh
rg "FrierenAppHost|dispatchAppRpc|app-rpc|virtual:@justfiles/apps|@justfiles/app/sdk" apps/frieren
pnpm --filter @justfiles/frieren typecheck
pnpm test
```

Expected: no runtime references.

---

## Step 4.4 — Remove legacy `/apps/*` static app routes

### What

In `apps/frieren/worker/index.ts`, remove:

- `SDK_JS`
- `hasApp`
- `getEntryPath`
- `/apps/__sdk.js`
- `/apps/__kernel_hello` if no longer useful
- `/apps/*` route
- SDK injection helpers
- old comments about iframe CORS

Keep:

```ts
app.get('/api/kernel/:appId/ws', tokenWs)
app.get('/api/kernel/:appId/*', tokenWs)
```

### Why

No bundled static app registry remains. Kernel app assets are per-user and served through the DO route.

### Verification

```sh
rg "__sdk|/apps/|SDK_JS|hasApp|getEntryPath" apps/frieren/worker
pnpm --filter @justfiles/frieren typecheck
```

---

# Phase 5 — Move capabilities under the app system

## Step 5.1 — Move capability source files under kernel during transition

### What

Move:

```txt
packages/app/capabilities/*
```

to:

```txt
packages/app/kernel/capabilities/*
```

Update imports in kernel SDK:

```ts
import type { CapabilityFactory } from './capabilities/core.ts'
```

instead of:

```ts
import type { CapabilityFactory } from '../capabilities/core.ts'
```

### Why

Capabilities are part of the app action sandbox model. They are not legacy. Keeping them next to kernel makes that explicit while the code still lives under `kernel/`.

### How

During transition, package exports can support both paths if desired:

```json
{
	"./kernel/capabilities": "./kernel/capabilities/index.ts",
	"./kernel/capabilities/ai": "./kernel/capabilities/ai/index.ts"
}
```

But final target should be root capabilities:

```json
{
	"./capabilities": "./capabilities/index.ts",
	"./capabilities/ai": "./capabilities/ai/index.ts"
}
```

Do not keep old compatibility longer than needed.

### Verification

Update app imports temporarily to the transition path:

```ts
import { ai } from '@justfiles/app/kernel/capabilities/ai'
```

Run:

```sh
pnpm typecheck
pnpm test
```

---

# Phase 6 — Migrate create-app template

## Step 6.1 — Replace legacy template with kernel template

### What

Remove template code using:

```ts
window.app
@justfiles/app/sdk
@justfiles/app/vite
appBuilder()
```

New template shape:

```txt
template/src/app.ts
template/src/gui.ts
template/vite.config.ts
```

Example `src/app.ts`:

```ts
import { defineApp } from '@justfiles/app/kernel/sdk'
import * as v from 'valibot'

export const app = defineApp({
	init: { count: 0 },
	handlers: {
		increment: {
			description: 'Increase the counter.',
			schema: v.object({ amount: v.number() }),
			examples: [{ params: { amount: 1 } }],
			handler({ amount }, ctx) {
				return { count: ctx.state.count + amount }
			}
		}
	}
})

export type ExampleApp = typeof app
```

Example `src/gui.ts`:

```ts
import { defineGUI } from '@justfiles/app/kernel/sdk'
import type { ExampleApp } from './app'

export const gui = defineGUI<ExampleApp>({
	mount(el, state, ctx) {
		const button = document.createElement('button')
		button.textContent = `count: ${(state as { count?: number } | null)?.count ?? 0}`
		button.onclick = () => void ctx.client.increment({ amount: 1 })
		el.append(button)
		return {
			update(next) {
				button.textContent = `count: ${(next as { count?: number } | null)?.count ?? 0}`
			},
			unmount() {
				el.replaceChildren()
			}
		}
	}
})
```

Example `vite.config.ts`:

```ts
import { kernelHost } from '@justfiles/app/kernel/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		kernelHost({
			id: 'app.example.counter',
			name: 'Counter',
			description: 'A tiny kernel app.',
			app: 'src/app.ts',
			gui: 'src/gui.ts'
		})
	]
})
```

### Why

New apps should be generated into the only supported app system.

### Verification

Generate or manually run template package:

```sh
pnpm --filter @justbuddy/create-app typecheck
# plus template build if package has a fixture command
```

At minimum:

```sh
rg "window\.app|appBuilder|@justfiles/app/sdk|@justfiles/app/vite" packages/create-app
```

Expected: no matches, except maybe docs explaining migration.

---

# Phase 7 — Delete legacy `packages/app` modules

## Step 7.1 — Remove old source files and tests

### What

Delete legacy source:

```txt
packages/app/sdk.ts
packages/app/protocol.ts
packages/app/client.ts
packages/app/host.ts
packages/app/format.ts
packages/app/contract.ts
packages/app/app-loader.ts
packages/app/host-factory.ts
packages/app/manifest-loader.ts
packages/app/vite-plugin.ts
packages/app/virtual.d.ts
```

Delete corresponding tests:

```txt
packages/app/sdk.test.ts
packages/app/client.test.ts
packages/app/host.test.ts
packages/app/contract.test.ts
packages/app/app-loader.test.ts
packages/app/host-factory.test.ts
packages/app/manifest-loader.test.ts
packages/app/vite-plugin.test.ts
packages/app/surface.test.ts
```

Keep and update:

```txt
packages/app/kernel/*
packages/app/kernel/*.test.ts
packages/app/kernel/capabilities/*
```

### Why

These files are old app systems. Keeping them after migration creates false surface area and future confusion.

### Verification

```sh
rg "window\.app|AppRelay|AppHost|AppRpc|hostApps|appBuilder|loadApp|createHost|virtual:@justfiles/apps" packages/app apps/frieren packages/create-app
```

Expected: no matches, except intentionally retained documentation during the same PR if desired.

---

## Step 7.2 — Simplify `packages/app/package.json` exports

### What

During transition, exports may still be kernel-prefixed:

```json
{
	"exports": {
		".": "./kernel/sdk.ts",
		"./kernel": "./kernel/kernel.ts",
		"./kernel/sdk": "./kernel/sdk.ts",
		"./kernel/vite": "./kernel/vite.ts",
		"./kernel/dev-server": "./kernel/dev-server.ts",
		"./kernel/capabilities": "./kernel/capabilities/index.ts",
		"./kernel/capabilities/ai": "./kernel/capabilities/ai/index.ts"
	}
}
```

Final target is not kernel-prefixed:

```json
{
	"exports": {
		".": "./index.ts",
		"./vite": "./vite.ts",
		"./capabilities": "./capabilities/index.ts",
		"./capabilities/ai": "./capabilities/ai/index.ts"
	}
}
```

But do the final physical move in Phase 8.

Also remove old deps if unused:

- `typebox` from `@justfiles/app`
- browser SDK IIFE build command

### Why

The package should not advertise deleted app systems.

### Verification

```sh
pnpm --filter @justfiles/app typecheck
pnpm typecheck
```

---

# Phase 8 — Final rename/move: make app system occupy package root

Do this only after the mass deletion is stable.

## Step 8.1 — Move kernel files to root-level package files

### What

Suggested final layout:

```txt
packages/app/app.ts          # from kernel/app.ts
packages/app/kernel.ts       # from kernel/kernel.ts, or runtime.ts if clearer
packages/app/sdk.ts          # from kernel/sdk.ts
packages/app/vite.ts         # from kernel/vite.ts
packages/app/dev-server.ts   # from kernel/dev-server.ts, private-ish export if needed
packages/app/capabilities/*  # from kernel/capabilities/*
```

`index.ts` should export author-facing SDK and host/kernel runtime types intentionally:

```ts
export {
	defineApp,
	defineGUI,
	createClient,
	type Client,
	type Transport
} from './sdk.ts'

export {
	kernel,
	type Action,
	type ActionMeta,
	type AppBundle,
	type AppManifest,
	appBundleFromMemory
} from './kernel.ts'
```

If the root surface feels too broad, keep runtime under a subpath:

```txt
@justfiles/app          defineApp, defineGUI, client/transport types, AppManifest
@justfiles/app/runtime  kernel(), AppBundle, install/dispatch runtime types
@justfiles/app/vite     kernelHost()
```

Pick one and document it.

### Why

After cleanup, “kernel” is no longer one app system among many. It is the app system. Import paths should reflect that.

### How

Update imports across repo:

```ts
import { defineApp } from '@justfiles/app/kernel/sdk'
```

to:

```ts
import { defineApp } from '@justfiles/app'
```

```ts
import { kernel } from '@justfiles/app/kernel'
```

to either:

```ts
import { kernel } from '@justfiles/app/runtime'
```

or:

```ts
import { kernel } from '@justfiles/app'
```

For Vite:

```ts
import { kernelHost } from '@justfiles/app/vite'
```

For capabilities:

```ts
import { ai } from '@justfiles/app/capabilities/ai'
```

### Verification

```sh
rg "@justfiles/app/kernel" . -g '!**/node_modules/**' -g '!packages/app/dist/**'
pnpm typecheck
pnpm test
```

Expected: no `@justfiles/app/kernel` imports remain.

---

## Step 8.2 — Rewrite `packages/app/README.md`

### What

Replace legacy iframe README with kernel app docs.

Must cover:

- headless app + GUI split,
- `defineApp`, actions, Standard Schema validation,
- `defineGUI`, typed client, transport/state subscription,
- app manifest and build output,
- capabilities,
- Frieren install model,
- package exports.

Minimal example:

```ts
// app.ts
import { defineApp } from '@justfiles/app'
import * as v from 'valibot'

export const app = defineApp({
	init: { count: 0 },
	handlers: {
		increment: {
			schema: v.object({ amount: v.number() }),
			handler: ({ amount }, ctx) => ({ count: ctx.state.count + amount })
		}
	}
})

export type CounterApp = typeof app
```

```ts
// gui.ts
import { defineGUI } from '@justfiles/app'
import type { CounterApp } from './app'

export const gui = defineGUI<CounterApp>({
	mount(el, state, ctx) {
		// render state, call ctx.client.increment(...)
		return { update() {}, unmount() {} }
	}
})
```

### Verification

Docs-only check:

```sh
pnpm format
```

---

# Phase 9 — Final cleanup and repo-wide verification

## Step 9.1 — Remove stale docs or mark as historical

### What

Review docs that mention old app systems:

- old iframe app README references,
- old `window.app` mentions,
- old `hostApps()` mentions,
- old `createHost()` / ESM loader docs.

Keep ADRs if they document the kernel design. Mark old docs as historical or delete if misleading.

### Verification

```sh
rg "window\.app|iframe|hostApps|appBuilder|AppRelay|AppHost|loadApp|createHost|virtual:@justfiles/apps" docs packages apps -g '!**/node_modules/**' -g '!docs/app-system-kernel-cleanup-plan.md'
```

Expected: no matches outside this historical plan.

---

## Step 9.2 — Full verification

Run required repo checks:

```sh
pnpm format
pnpm typecheck
pnpm lint:fix
pnpm test
```

For Frieren UI smoke:

```sh
cd apps/frieren
pnpm run dev
# another shell
pnpm run verify:ui
```

Manual smoke scenarios:

1. Launch Frieren.
2. See builtin Settings.
3. Install app-counter from built `dist/`.
4. Launch app-counter.
5. Click increment/decrement.
6. Close app.
7. Reconnect and confirm current app restoration works if intended.
8. Uninstall app-counter.
9. Install and launch app-crossword.
10. Trigger a crossword action using the GUI and/or `app run` agent command.
11. Install and launch app-doom; confirm WASM/WAD assets load.

---

# Deferred improvement — per-app dispatch serialization

## Status

Do not include in the cleanup PR unless it becomes necessary.

## Why it matters

Current kernel dispatch has a possible race:

```ts
current = await loadState()
result = await sandbox.run(action, { state: current })
await saveState(result)
```

Two concurrent increments can both read `count = 0` and both save `count = 1`.

## Why it is deferred

- It is not a legacy parity issue.
- Legacy did not solve it either.
- It changes runtime semantics and deserves a focused test/review.

## Likely implementation

Add a per-app promise queue in `kernel()`:

```ts
const queues = new Map<AppId, Promise<unknown>>()

async function serialize<T>(appId: AppId, fn: () => Promise<T>): Promise<T> {
	const prev = queues.get(appId) ?? Promise.resolve()
	const next = prev.then(fn, fn)
	queues.set(
		appId,
		next.finally(() => {
			if (queues.get(appId) === next) queues.delete(appId)
		})
	)
	return next
}
```

Wrap dispatch:

```ts
async function dispatch(appId: AppId, action: Action): Promise<unknown> {
	return serialize(appId, async () => {
		// existing dispatch body
	})
}
```

Regression test:

```ts
await Promise.all([
	k.dispatch(appId, { type: 'increment', params: { amount: 1 } }),
	k.dispatch(appId, { type: 'increment', params: { amount: 1 } })
])
expect(await k.state(appId)).toEqual({ count: 2 })
```

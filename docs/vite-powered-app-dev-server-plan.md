# Vite-powered app dev server plan

## Goal

Move standalone app development (`cd packages/app-* && pnpm dev`) onto Vite's native dev module graph instead of hand-bundling browser code with esbuild.

Target shape:

- app GUIs are served by Vite as normal browser modules during dev;
- React is deduped by Vite, not hand-vendored by the app dev server;
- Vite plugins, React Refresh, source maps, CSS handling, aliases, and HMR work for app GUIs;
- production output keeps the current app contract: `gui.js` externalizes React and hosts resolve it through their importmap.

This plan intentionally starts with the stable Vite JavaScript/plugin APIs, then optionally adopts the newer Environment/Builder APIs once the simpler path is proven.

## Vite docs reading checklist

Read these before implementing. They are the key APIs that make the plan possible.

1. **JavaScript API — `createServer`, middleware mode, `transformIndexHtml`, `ssrLoadModule`**
   - <https://vite.dev/guide/api-javascript.md>
   - Why: programmatic Vite server, custom middleware integration, HTML transforms that inject `/@vite/client` and React plugin preambles.

2. **Plugin API — virtual modules, `configureServer`, `transformIndexHtml`, HMR hooks**
   - <https://vite.dev/guide/api-plugin.md>
   - Why: app GUI wrapper should be a Vite virtual module; custom routes stay in a plugin/middleware; HMR can be customized if needed.

3. **Shared options — `resolve.dedupe`**
   - <https://vite.dev/config/shared-options.md#resolve-dedupe>
   - Why: Vite's documented fix for duplicated dependencies in monorepos/linked packages. Use for `react`, `react-dom`, and React runtime subpaths.

4. **Environment API overview**
   - <https://vite.dev/guide/api-environment.md>
   - Why: explains multi-environment dev/build and why Cloudflare can run Workers in `workerd` while Vite still owns transforms.

5. **Environment API for Frameworks — `RunnableDevEnvironment`, `runner.import`, `builder.buildApp`**
   - <https://vite.dev/guide/api-environment-frameworks.md>
   - Why: future path for running `src/app.ts` through Vite and eventually building `app.js` + `gui.js` as coordinated environments.

6. **Environment API for Runtimes — `ModuleRunner`, custom runtime transports**
   - <https://vite.dev/guide/api-environment-runtimes.md>
   - Why: background for the Cloudflare-style setup and for any future app-kernel runtime that is not plain Node.

7. **Environment API for Plugins — per-environment hooks and `hotUpdate`**
   - <https://vite.dev/guide/api-environment-plugins.md>
   - Why: needed if `kernelHost` grows into a multi-environment Vite plugin.

8. **Cloudflare Vite plugin docs/source**
   - Docs: <https://developers.cloudflare.com/workers/vite-plugin/>
   - Package: `@cloudflare/vite-plugin`
   - Why: production-grade prior art for using Vite environments to run server/edge code in a production-like runtime during dev.

## Current architecture to keep in mind

Relevant files:

- `packages/app/vite.ts` — `kernelHost()` Vite plugin. In dev, it installs custom middleware. In build, it emits `dist/gui.js`, `dist/app.js`, manifest, and bundle.
- `packages/app/dev-server.ts` — standalone app dev host. Today it owns kernel setup, fake local capabilities, GUI serving, state/dispatch endpoints.
- `packages/app/dev-server.html` — standalone app shell.
- `packages/app/react-entry.ts` — shared React GUI wrapper source generation.
- `packages/app/react.ts` — `reactGui()` adapter.
- `packages/app/README.md` — app authoring/runtime contract.

Important constraints:

- The reducer/kernel side is not a browser app. It must keep running through the kernel sandbox/capability path.
- Production hosts (`frieren`, `quay`) still expect built app `gui.js` to import React as bare specifiers and resolve them through host importmaps.
- App packages should keep React/ReactDOM as peer + dev dependencies for typechecking and local dev resolution.

## Phase 0 — Baseline and safety checks

### Goal

Record the current standalone app behavior and create a repeatable smoke loop before changing the dev server again.

### Work

- Pick at least two apps:
  - `packages/app-notes` — default-export React GUI wrapped by `reactGui()`.
  - `packages/app-files` — imperative `defineGUI` React GUI.
- Confirm current `pnpm dev` renders both.
- Capture what browser console errors are acceptable. `favicon.ico` 404 is currently acceptable; invalid hook call is not.

### Verification

```sh
cd packages/app-notes
pnpm dev --host 127.0.0.1
```

In another shell:

```sh
playwright-cli -s=app-notes-vite open http://127.0.0.1:5173
playwright-cli -s=app-notes-vite console error
playwright-cli -s=app-notes-vite snapshot
playwright-cli -s=app-notes-vite close
```

Repeat for `packages/app-files`.

Exit criteria:

- both apps render;
- no `Invalid hook call`;
- root repo checks still pass after any preparatory changes:

```sh
pnpm format
pnpm typecheck
pnpm lint:fix
pnpm test
```

## Phase 1 — Serve GUI through Vite dev modules

### Goal

Replace the standalone dev server's GUI esbuild bundle with a Vite-served module, while leaving `src/app.ts` and the kernel sandbox unchanged.

This is the main simplification phase: Vite owns TSX transforms, React Refresh setup, source maps, CSS/module resolution, and dependency optimization for GUI code.

### Design

Add a Vite virtual module for the GUI entry. Conceptually:

```ts
// virtual:justfiles-app/gui
import * as mod from '/src/gui.tsx'
import { reactGui } from '@justfiles/app/react'

export const gui = reactGui(mod)
```

For non-React `.ts` GUI entries, the virtual module can simply forward the app's own `gui` export:

```ts
export { gui } from '/src/gui.ts'
```

The dev HTML imports the virtual module instead of `/app.js`:

```ts
import { gui } from 'virtual:justfiles-app/gui'
```

The middleware must serve HTML through Vite:

```ts
html = await viteServer.transformIndexHtml(url, html)
```

That is what lets Vite inject `/@vite/client`, React Refresh preambles from `@vitejs/plugin-react`, and other plugin HTML transforms.

Add Vite dedupe in serve mode:

```ts
resolve: {
	dedupe: [
		'react',
		'react-dom',
		'react-dom/client',
		'react/jsx-runtime',
		'react/jsx-dev-runtime'
	]
}
```

### Work

- Update `kernelHost()`'s dev path in `packages/app/vite.ts` to pass the Vite dev server into `createDevServer()` or equivalent.
- Add a small internal Vite plugin/module resolver for `virtual:justfiles-app/gui`.
- Update `packages/app/dev-server.html` to import the virtual module.
- In the standalone dev route for `/`, call `server.transformIndexHtml()` before responding.
- Stop serving a dev-only React vendor/importmap from `packages/app/dev-server.ts` once the Vite path is proven.
- Keep the existing build path untouched.

### Verification

Start Notes:

```sh
cd packages/app-notes
pnpm dev --host 127.0.0.1
```

Check the served HTML contains Vite dev client wiring:

```sh
curl -fsS http://127.0.0.1:5173/ | grep -E '/@vite/client|react-refresh|virtual:justfiles-app'
```

Browser smoke:

```sh
playwright-cli -s=app-notes-vite open http://127.0.0.1:5173
playwright-cli -s=app-notes-vite console error
playwright-cli -s=app-notes-vite snapshot
playwright-cli -s=app-notes-vite close
```

Network/import smoke:

```sh
curl -fsS http://127.0.0.1:5173/src/gui.tsx >/tmp/gui.out
curl -fsS 'http://127.0.0.1:5173/@id/virtual:justfiles-app/gui' >/tmp/virtual-gui.out || true
```

Exit criteria:

- Notes and Files render.
- No invalid hook call.
- Browser requests go through Vite module URLs (`/@vite/client`, `/src/gui.tsx`, virtual module), not a hand-built `/app.js` GUI bundle.
- Production `pnpm --filter @justfiles/app-notes build` still emits bare React imports in `dist/gui.js`.
- Root checks pass.

## Phase 2 — GUI HMR lifecycle

### Goal

Make GUI edits update through Vite HMR/React Refresh without losing kernel state or leaking old GUI instances.

### Design

Vite/React Refresh may handle component-only edits automatically once the GUI is a Vite module. For edits that change the GUI module shape (`menu`, `gui`, default export wrapper), add a small app dev bootstrap module with explicit HMR handling.

Conceptual bootstrap:

```ts
import { gui } from 'virtual:justfiles-app/gui'

let instance = gui.mount(root, state, { transport })

if (import.meta.hot) {
	import.meta.hot.accept('virtual:justfiles-app/gui', async (next) => {
		await instance.unmount()
		instance = next.gui.mount(root, latestState, { transport })
	})
}
```

Keep `latestState` updated from the existing subscription transport so remounts preserve reducer state.

### Work

- Move the inline dev HTML module into a Vite-served bootstrap module, or keep inline HTML only if HMR is proven to work reliably.
- Track `latestState` in the bootstrap.
- On accepted GUI updates, unmount the old GUI instance before mounting the new one.
- If React Refresh handles component-only changes, do not add extra remounting for those; only handle module-boundary changes.

### Verification

Run Notes dev. Then make a temporary text-only GUI edit, such as changing the textarea placeholder.

Expected:

- browser updates without manual reload;
- current note/editor state remains intact where possible;
- no duplicate event handlers after repeated edits;
- no console errors except known favicon 404.

Manual smoke:

```sh
playwright-cli -s=app-notes-hmr open http://127.0.0.1:5173
playwright-cli -s=app-notes-hmr fill 'textarea' 'hmr state survives'
# edit src/gui.tsx in another shell, then:
playwright-cli -s=app-notes-hmr snapshot
playwright-cli -s=app-notes-hmr console error
playwright-cli -s=app-notes-hmr close
```

Exit criteria:

- HMR works for component edits.
- Full reload is acceptable for app-boundary edits only if documented.
- Kernel state is not reset on component HMR.
- Root checks pass.

## Phase 3 — Run `src/app.ts` through Vite in dev

### Goal

Stop esbuild-bundling the headless app entry during standalone dev. Let Vite transform and load `src/app.ts`, while preserving the kernel/capability architecture.

### Design options

Start with the conservative API:

```ts
const mod = await viteServer.ssrLoadModule('/src/app.ts')
```

Then consider the Environment API version:

```ts
const mod = await server.environments.ssr.runner.import('/src/app.ts')
```

The dev sandbox can ignore the installed placeholder `app.js` bytes and resolve the real app module through Vite. The returned sandbox shape remains unchanged:

```ts
{
	run: (action, ctx) => mod.app.dispatch(action, ctx),
	initialState: async () => mod.app.initialState,
	actions: async () => mod.app.actions ?? {},
	capabilities: async () => mod.app.capabilities ?? {},
	runProcedure: (...args) => mod.app.runProcedure(...args),
	subscriptions: async (state) => mod.app.subscriptions?.(state) ?? []
}
```

### Work

- Change the standalone dev sandbox factory to load `opts.app` through Vite in dev.
- Keep production and app bundle build unchanged.
- Decide how app module hot updates affect kernel caches:
  - procedure-name metadata may need invalidation;
  - subscriptions may need reconciliation;
  - existing state should generally survive code reloads.
- If needed, add a dev-only kernel reinstall/reconcile path on app module changes.

### Verification

Use a simple app where `src/app.ts` behavior can be changed visibly.

Manual loop:

1. Start app dev.
2. Dispatch an action.
3. Edit `src/app.ts` action behavior or metadata.
4. Dispatch again without restarting dev server.
5. Confirm new behavior is used and previous state is preserved unless the app's own logic changes it.

For Notes specifically:

- edit an action/procedure description or a harmless state transition;
- call the action through the GUI or direct `/_dispatch`;
- confirm the new app module is active.

Exit criteria:

- `src/app.ts` changes are picked up without restarting Vite.
- No state loss on code-only edits unless explicitly expected.
- Capabilities remain scoped by kernel declarations, not by untrusted runtime claims.
- Root checks pass.

## Phase 4 — Optional: Vite Environment API for kernel runtime

### Goal

Model the app's browser GUI and headless reducer as explicit Vite environments during dev.

### Why not first

Vite currently marks the Environment API as release-candidate. It is powerful and relevant, but Phase 1 can deliver most of the dev benefit with stable APIs.

### Design

Potential environment layout:

```ts
environments: {
	client: {},
	kernel: {
		consumer: 'server',
		// later: custom dev environment if app code runs outside Node
	}
}
```

The `kernel` environment can initially be a `RunnableDevEnvironment` running in the same Node process. Later, it could become a custom runtime if we want stronger isolation or production-like execution.

### Work

- Replace `ssrLoadModule` usage from Phase 3 with `server.environments.kernel.runner.import()`.
- Key plugin state by `this.environment` where needed.
- Add per-environment HMR handling for app code changes.
- Keep client/GUI environment independent from kernel environment.

### Verification

- Same as Phase 3, plus inspect that client and kernel modules have separate environment/module graphs.
- App GUI HMR should not reload kernel modules unless they are actually imported by kernel code.
- App reducer HMR should not reload browser modules unless the browser bootstrap must remount.

Exit criteria:

- Multi-environment dev works for Notes and Files.
- No regression in production build.
- Root checks pass.

## Phase 5 — Optional: Vite Builder for production app artifacts

### Goal

Use Vite's build-time environment coordination to emit `gui.js`, `app.js`, `manifest.json`, and `bundle.js` from a single app build pipeline.

### Design

Potential build environments:

```ts
environments: {
	client: {
		build: {
			lib: { entry: guiEntry, formats: ['es'], fileName: () => 'gui.js' },
			rollupOptions: { external: REACT_EXTERNAL }
		}
	},
	kernel: {
		build: {
			lib: { entry: appEntry, formats: ['es'], fileName: () => 'app.js' }
		}
	}
}
```

Use `builder.buildApp` or plugin `buildApp` hooks to coordinate both outputs, then emit the manifest and builtin bundle.

### Work

- Prototype on one app only, preferably `packages/app-notes`.
- Ensure `gui.js` output still externalizes React exactly as hosts expect.
- Ensure `app.js` is still self-contained enough for current sandboxes.
- Compare produced `dist/` layout with current `kernelHost` output.

### Verification

```sh
pnpm --filter @justfiles/app-notes build
node -e "import('./packages/app-notes/dist/bundle.js').then(m => console.log(m.default.id, Object.keys(m.default.files)))"
grep -E 'from "react"|from "react-dom/client"' packages/app-notes/dist/gui.js
```

Then run a host smoke if available:

```sh
pnpm --filter @justfiles/quay assets
pnpm --filter frieren typecheck
```

Exit criteria:

- Built app artifacts match the existing host contract.
- Builtin bundle import still works.
- Frieren/quay can install and render the app.
- Root checks pass.

## Phase 6 — Cleanup and consolidation

### Goal

Remove now-obsolete custom dev bundling/vendor code and leave a small, documented app dev path.

### Work

- Delete dev-only React vendor/importmap shim code from `packages/app/dev-server.ts` if Phase 1 made it obsolete.
- Keep one shared list of React external specifiers for production build.
- Update `packages/app/README.md` with the new dev/build split:
  - dev: Vite module graph + dedupe;
  - build/prod: external React + host importmap.
- Update `packages/create-app/template` docs only if app authors need to know anything new. Ideally they should not.

### Verification

- `packages/app-notes` and `packages/app-files` standalone dev render.
- HMR works for GUI edits.
- `pnpm --filter @justfiles/app-notes build` still emits valid `dist/`.
- Root checks pass:

```sh
pnpm format
pnpm typecheck
pnpm lint:fix
pnpm test
```

## Recommended implementation order

Do not jump straight to Vite Environment API or Builder API.

Recommended order:

1. Phase 0 — lock down the smoke loop.
2. Phase 1 — GUI through Vite dev modules.
3. Phase 2 — GUI HMR lifecycle.
4. Phase 6 partial — remove obsolete dev vendor code.
5. Phase 3 — app entry through Vite dev loader.
6. Phase 4 — Environment API only if Phase 3's simpler API is limiting.
7. Phase 5 — Builder API only after dev is stable.

The first two phases should deliver the main user-visible benefit: standalone app dev feels like a normal Vite React project, while production remains host/importmap based.

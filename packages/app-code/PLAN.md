# app-code — executable build plan

Companion to `DESIGN.html`. Seven self-contained slices, in dependency order.
Each is shippable on its own and ends with a concrete **Verify** step. Code
samples illustrate only the load-bearing logic.

> Ground rules (`CLAUDE.md`): keep code minimal; tab indentation; prefer
> composing existing generic infra over app-code-only APIs. After each slice:
> `pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test`.

## Architecture in one paragraph

app-code is an **ordinary sandboxed app** — a package with `defineApp` +
`defineGUI`, shipped and installed through the **same machinery as
files/settings** (no native/sandboxed split, no `defineGUI` change). Its
reducer reads/writes project source through the **`volume` capability**, exactly
like files. The one privileged thing it does — compile a draft, run it in a
scoped kernel, and embed that live app in its own window — is expressed as a
**single `devkit` capability** that app-code *declares* and the host *grants*
(allowlist now, user-consent later). Privilege is graduated via capabilities,
the system's existing entitlement currency: **anyone could build a competing
Xcode-for-Frieren by declaring `devkit` and being granted it.**

Why this is mechanically clean: `devkit` is a **local, main-thread capability**
(like `volume` in the browser — it never serializes to the server). Its impl
*is* frieren main-thread code, so it holds `host` / `createClientKernel` /
`chroot` / the esbuild toolchain natively. It reaches into the **caller's own
stage** (`wrapperOf(appId)`) and parents the running draft at a DOM slot the gui
rendered (`[data-preview-slot]`). No DOM ever crosses the worker boundary; the
reducer only ever sends/receives serializable values (file strings, ids, zip
bytes). **The sandbox isn't discarded — it's used where it belongs:** the draft
runs in a real `browserSandbox` via the scoped kernel (our "Simulator"). The
tool is unsandboxed-by-grant; the product it builds is sandboxed.

---

## Slice 0 — Ship app-code as a real built-in

**Goal:** the existing mock appears in the launcher and opens, shipped through
the same pipeline as `app-paint`/`app-files`. No behavior change yet.

**Touches:** `packages/app-code/vite.config.ts` (identity),
`apps/frieren/vite-appstore.ts` (`BUILTIN_DIRS`), build ordering so app-code's
`dist` exists before frieren builds.

```ts
// vite.config.ts — the real identity the rest of the plan uses.
kernelHost({ id: 'app.code', name: 'Code', icon: 'icon.svg',
	description: 'Build and run apps directly in Kodama.', app: 'src/app.ts', gui: 'src/gui.ts' })
```
```ts
// apps/frieren/vite-appstore.ts
const BUILTIN_DIRS = ['app-paint', 'app-files', 'app-settings', 'app-code']
```

**Verify:** `pnpm --filter @justfiles/app-code build` emits
`dist/{manifest.json,app.js,gui.js,bundle.js}`; in frieren a “Code” icon
launches and the mock renders with no console errors.

---

## Slice 1 — Real project files via the `volume` capability (read-only)

**Goal:** replace the in-state mock `files[]` with a project on disk under
`/data/app.code/projects/<slug>/src`, read through `volume`. Drop the
`code`/`agent` mode and the chat mock.

**Touches:** `packages/app-code/src/app.ts` (state + actions),
`src/gui.ts` (explorer + read-only source), a seed scaffold.

```ts
import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'

export type CodeState = {
	slug: string
	files: string[]                 // src-relative, sorted
	selectedPath: string | null
	rightPane: 'editor' | 'preview'
	previewId: string | null
	diagnostics: string[]
}
const SRC = (slug: string, p = '') => `/projects/${slug}/src${p}`

export const app = defineApp({
	init: { slug: 'untitled', files: [], selectedPath: null, rightPane: 'editor',
		previewId: null, diagnostics: [] },
	capabilities: { volume: volume() },        // default 'app' scope → /data/app.code
	actions: (b) => ({
		open: b.handler({ schema: v.object({ slug: v.string() }), async handler({ slug }, ctx) {
			if (!(await ctx.capabilities.volume.exists({ path: SRC(slug) }))) await seed(ctx.capabilities.volume, slug)
			const entries = await ctx.capabilities.volume.scan({ path: SRC(slug), recursive: true })
			const files = entries.filter((e) => e.type === 'file')
				.map((e) => e.path.slice(SRC(slug).length + 1)).sort()
			return { ...ctx.state, slug, files, selectedPath: files[0] ?? null }
		}}),
		select: b.handler({ schema: v.object({ path: v.string() }),
			handler({ path }, ctx) { return { ...ctx.state, selectedPath: path } } }),
		readFile: b.query({ schema: v.object({ path: v.string() }), async handler({ path }, ctx) {
			return new TextDecoder().decode(await ctx.capabilities.volume.readFile({ path: SRC(ctx.state.slug, `/${path}`) }))
		}})
	})
})
```

`seed()` writes a two-file starter (`app.ts` + `gui.ts`) via `volume.writeFile`.
GUI: explorer lists `state.files`; selecting calls `select` + `readFile` and
shows the text (plain `<pre>` is fine this slice).

**Verify:** open app-code → seeded files appear; selecting shows content; files
are real on disk (open the same paths in Files).

---

## Slice 2 — Editing with CodeMirror + debounced save

**Goal:** editable editor; edits persist to the volume.

**Touches:** `src/gui.ts` (CodeMirror), a `write` handler; add `codemirror` deps.

```ts
// app.ts
write: b.handler({ schema: v.object({ path: v.string(), content: v.string() }), async handler({ path, content }, ctx) {
	await ctx.capabilities.volume.writeFile({ path: SRC(ctx.state.slug, `/${path}`), data: new TextEncoder().encode(content) })
	return ctx.state            // bytes live on disk; no state change
}})
```
```ts
// gui.ts — debounced flush through the typed client
const flush = debounce((path, content) => void client.write({ path, content }), 400)
// CodeMirror updateListener: if (u.docChanged) flush(currentPath, u.state.doc.toString())
```

**Verify:** edit a file, wait the debounce, reload app-code → change persists.

---

## Slice 3 — The `devkit` capability (the one new platform piece)

**Goal:** add a single privileged, host-gated capability that compiles a draft,
runs it in a scoped kernel, and embeds the live app at the caller's
`[data-preview-slot]`. The Frieren build toolchain (esbuild-wasm) is **provided
by the system here**, not by the app.

**Touches:**
- `packages/app/capabilities/devkit/{contract.ts,index.ts}` — **new** SDK
  capability (sits beside `volume`).
- `apps/frieren/src/apps/devkit.capability.ts` — **new** browser impl (the
  toolchain + host wiring). frieren gains `esbuild-wasm`.
- `apps/frieren/src/apps/capabilities.client.ts` — route `devkit` locally.
- `apps/frieren/shared/devkit.allowlist.ts` — the grant gate (v1: a constant).

```ts
// packages/app/capabilities/devkit/contract.ts — all I/O serializable.
export interface DevkitCapability {
	run(i: { slug: string; files: Record<string, string> }): Promise<{ previewId: string; diagnostics: string[] }>
	stop(i: { previewId: string }): Promise<void>
	install(i: { slug: string; files: Record<string, string> }): Promise<{ id: string }>
	pack(i: { slug: string; files: Record<string, string> }): Promise<{ zip: Uint8Array }>
}
// index.ts
import { defineCapability } from '../core.ts'
export const devkit = defineCapability<'devkit', DevkitCapability>('devkit')
```

```ts
// apps/frieren/src/apps/capabilities.client.ts — devkit runs LOCALLY, never to server.
if (req.capability === 'devkit') {
	if (!DEVKIT_ALLOWLIST.has(req.appId)) throw capabilityError('CAPABILITY_UNAVAILABLE', 'devkit', req.method)
	return invokeDevkit(fs, getToken, req)
}
```

```ts
// apps/frieren/src/apps/devkit.capability.ts — privilege held natively; DOM stays main-thread.
import { appBundleFromMemory } from '@justfiles/app'
import { chroot } from '@justfiles/fs'
import { createClientKernel } from './kernel.client'
import * as host from './host'
import { compile } from './devkit.compile'        // esbuild-wasm + React-external vfs plugin

async function run(fs, getToken, appId, { slug, files }) {
	const { app, gui, diagnostics } = await compile(files)          // system toolchain
	const runtimeRoot = `/data/${appId}/.devkit/${slug}`           // generic, caller-private
	const scoped = chroot(fs, runtimeRoot)
	const kernel = createClientKernel({ fs: scoped, getToken })
	const previewId = `preview.${slug}`
	await kernel.install(appBundleFromMemory({ id: previewId, name: slug, app, gui }))
	host.close(previewId)                                            // restart-safe
	host.open(previewId, { getToken, localKernel: async () => kernel, volume: Promise.resolve(scoped) })
	const slot = host.wrapperOf(appId)?.querySelector('[data-preview-slot]')   // caller's own stage
	const child = host.wrapperOf(previewId)
	if (slot && child) slot.replaceChildren(child)                   // same document, same thread
	return { previewId, diagnostics }
}
```

`compile` is the build chain the system provides — esbuild-wasm with a vfs
resolver over `files`, React kept external (resolved via the page importmap,
same as `kernelHost`):

```ts
const EXTERNAL = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime']
const one = (files, entry) => esbuild.build({ entryPoints: [entry], bundle: true, write: false,
	format: 'esm', external: EXTERNAL, plugins: [vfs(files)] }).then((r) => r.outputFiles[0].text)
```

**Verify (standalone, no app-code needed):** add `devkit` + `app.test.devkit`
to the allowlist; a throwaway app declaring `devkit` calls `devkit.run` with a
hardcoded two-file sample and renders `<div data-preview-slot>` → the sample app
mounts and runs inside the throwaway app's window. A non-allowlisted app calling
`devkit.run` gets `CAPABILITY_UNAVAILABLE`. Force a syntax error → `run` resolves
with non-empty `diagnostics` and keeps the last-good child mounted.

---

## Slice 4 — Wire the live loop in app-code

**Goal:** `[Editor | Preview]` toggle; on save (debounced) recompile-and-run via
`devkit`; error strip from diagnostics; `⟳ Run/Restart`.

**Touches:** `src/app.ts` (`run`/`stop`/`setPane` actions + declare `devkit`),
`src/gui.ts` (toolbar, persistent `[data-preview-slot]`, error strip).

```ts
// app.ts — app-code is still a normal app; privilege is one capability line.
capabilities: { volume: volume(), devkit: devkit() },
run: b.handler({ schema: v.object({}), async handler(_, ctx) {
	const files = await readAllSrc(ctx.capabilities.volume, ctx.state.slug)   // Record<path, content>
	const { previewId, diagnostics } = await ctx.capabilities.devkit.run({ slug: ctx.state.slug, files })
	return { ...ctx.state, previewId, diagnostics }
}}),
stop: b.handler({ schema: v.object({}), async handler(_, ctx) {
	if (ctx.state.previewId) await ctx.capabilities.devkit.stop({ previewId: ctx.state.previewId })
	return { ...ctx.state, previewId: null }
}})
```

```ts
// gui.ts — keep the slot element STABLE across re-renders so the host's child survives.
const slot = ensurePersistent('[data-preview-slot]')   // create once; never replaceChildren it
// after each debounced write flush, and on the Run button:
void client.run({})
// error strip renders state.diagnostics; previous canvas stays mounted on failure
```

`⟳ Run/Restart` = `stop` then `run` (optionally delete `…/.devkit/<slug>/state`
first for a clean boot; between runs the scoped state persists → hot-reload feel).

**Verify:** with Preview active, edit `gui.ts`’s rendered text → within ~½s the
embedded app updates in place. Introduce a compile error → error strip shows,
previous canvas stays. `⟳` resets in-app state.

---

## Slice 5 — Ship & share (Install + Pack + Import)

**Goal:** `⬆ Install` promotes the draft to the real `/applications`;
`⧉ Pack` returns a downloadable `.zip`; import reuses the existing path.

**Touches:** `devkit.capability.ts` (`install` guard, `pack` via `fflate`),
`src/gui.ts` (buttons + download). Import already exists (`installZipApp` +
`.zip` picker in `apps/hooks.ts`).

```ts
// devkit.capability.ts
async function install(fs, getToken, appId, { slug, files }) {
	const { app, gui } = await compile(files)
	const manifest = readManifest(files)                       // the draft's real id/name
	if ((await realKernel.list()).some((m) => m.id === manifest.id))
		throw new Error(`app id already exists: ${manifest.id}`) // app-code-level guard, no new install option
	await realKernel.install(appBundleFromMemory({ id: manifest.id, name: manifest.name, app, gui }))
	return { id: manifest.id }
}
async function pack(_fs, _t, _appId, { files }) {
	const { app, gui } = await compile(files)
	const manifest = readManifest(files)
	return { zip: zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)),
		'app.js': strToU8(app), 'gui.js': strToU8(gui) }) }      // fflate, already a dep
}
```
```ts
// gui.ts — Pack returns bytes; the gui turns them into a download.
const { zip } = await client.pack({})
downloadBlob(new Blob([zip], { type: 'application/zip' }), `${slug}.zip`)
```

**Verify:** Install a draft → it appears in the launcher and runs standalone
(own window, server sync). Pack → download `.zip` → import via the existing
`.zip` picker → `installZipApp` installs and runs it. Install a colliding id →
rejected with the guard message.

---

## Slice 6 — Polish & real consent

- **Replace the allowlist with a grant flow:** declaring `devkit` triggers a
  one-time user consent (it can run code + write `/applications`). This is the
  same consent the design wants before running a stranger’s packed app.
- **Canvas-focus**: collapse the explorer so the embedded preview goes
  full-width — the old “agent mode” for free (the system agent drives, you watch).
- **Diagnostics**: structured error list + runtime errors caught at the stage
  boundary, surfaced in the strip.
- **New-project scaffold** + multi-project switcher.
- **Monaco upgrade** for real IntelliSense — deliberate, heavier swap of the
  Slice 2 editor; not the default.

---

## Dependency graph

```
0 built-in ─▶ 1 read files ─▶ 2 edit/save ─▶ 4 live loop ─▶ 5 ship/share ─▶ 6 polish+consent
                                                  ▲
                          3 devkit capability ───┘   (independently verifiable
                                                        with a throwaway app)
```

Slice 3 (the only new platform surface) is built and verified **standalone** —
with a throwaway app declaring `devkit`, before app-code ever calls it — which
de-risks the capability + the toolchain in isolation. Everything in 0–2 is
verifiable without any compile-and-run. app-code stays an ordinary app
throughout; the entire privilege story is one capability the host grants.

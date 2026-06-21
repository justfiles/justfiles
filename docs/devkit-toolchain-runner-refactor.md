# Devkit refactor: `Toolchain` + `Runner` + a generic factory

## Goal

Collapse the bespoke per-host devkit wiring into **two injected seams** and **one
generic factory**. After this, a host implements the `devkit` capability by
supplying a `Toolchain` (how to compile) and a `Runner` (how to make a build
live) — nothing else. The custom devkit code in each host goes away.

This mirrors how every real platform splits the build pipeline: a swappable
*toolchain* (clang / d8 / Roslyn) and a swappable *loader/runtime* (dyld / ART /
CLR / `flatpak run`), with a generic, manifest-driven orchestrator (llbuild /
Gradle / MSBuild) in between that owns packaging + install and knows nothing
language- or loader-specific.

## Why (the redundancy we are removing)

- `engine.ts` exposes `Engine = { compile, typecheck }`; `engine.esbuild.ts`
  exposes a near-duplicate `Toolchain = { compile }` (the build-only subset).
  Hosts construct **both** for the same backend (see `quayd/devkit.ts` building
  a `toolchain()` *and* an `engine()` over one `compileBackend()`).
- The "make a draft live" hook (`run`/`stop`/`menu`/`selectMenu`) is
  reimplemented per host with no shared interface — desktop already half-named it
  (`Preview` in `apps/desktop/src/main/devkit.ts`).
- frieren does not even use `implementCapability`: `invokeDevkit` hand-rolls a
  `switch (method)` plus ~150 lines of `*Input` validators that the typed
  `implementCapability` seam makes unnecessary.

## Target architecture

Three layers, each with one job:

| Layer | File(s) | Role | Impls |
|---|---|---|---|
| **Toolchain** (source → artifacts) | `toolchain.ts` (+ `.esbuild`/`.typescript`/`.bun`/`.vfs`) | pure compile/typecheck seam | esbuild-wasm, native esbuild, typescript, bun |
| **Runner** (artifact → live instance) | `capabilities/devkit/host.ts` | mount/stop/drive a built draft | frieren DOM mount, quay hidden-kernel app, desktop WKWebView |
| **Generic factory** (orchestrator) | `capabilities/devkit/host.ts` | read manifest → compile → pack/install → delegate run | **one** impl |
| Pure pipeline helpers | `devkit.ts` | project I/O, `buildDraft`, zip, kernel write | **one** impl |

### Interfaces (concrete)

```ts
// toolchain.ts — the source→artifact seam (replaces Engine AND the old Toolchain)
export interface Toolchain {
	compile(input: ProjectInput): Promise<CompileResult>
	typecheck?(input: ProjectInput): Promise<CheckResult> // optional: browser/desktop omit it
}
// Compile, ProjectInput, CompileResult, CheckResult, Diagnostic, OutputFile,
// Position, Range, TypesBundle stay here unchanged.
```

```ts
// capabilities/devkit/host.ts — the launch seam + the generic factory
import type { DraftBuild } from '../../devkit.ts'
import type { MenuView } from './contract.ts'

export interface RunContext {
	appId: string
	slug: string
	previewId: string // `preview.${slug}`, computed by the factory
	reset?: boolean
}

// The loader. The factory only ever calls `mount` with a GOOD build (it guards
// diagnostics itself), so a Runner never has to re-check them.
export interface Runner {
	mount(draft: DraftBuild, ctx: RunContext): Promise<void>
	stop(input: { previewId: string }): Promise<void>
	// Optional + provisional — only frieren drives live preview menus today, and
	// we may drop them entirely. A host that omits them gets the factory's safe
	// defaults (empty menu / no-op), so quay/desktop need no stubs.
	menu?(input: { previewId: string }): Promise<MenuView>
	selectMenu?(input: { previewId: string; menu: number; item: number }): Promise<void>
}

// A Runner that mounts nothing (compile-only hosts / tests). `mount` + `stop` only.
export const noopRunner: Runner

export function devkitCapability(opts: {
	fs: Volume
	toolchain: () => Promise<Toolchain> // lazy: a session that never builds pays nothing
	runner: Runner
	kernel: () => Kernel // the SHIP kernel for install/pack (the runner owns its own preview kernel)
	onInstalled?: () => void | Promise<void>
	overwrite?: boolean // quay ships-or-updates; frieren/desktop create-only
}): Capability
```

The factory body (sketch) — this is the *only* place the capability methods live:

```ts
return implementCapability(devkit, {
	compile: async (ctx, { slug }) =>
		(await toolchain()).compile((await readProject(data(ctx), slug)).input),
	typecheck: async (ctx, { slug }) => {
		const tc = await toolchain()
		if (!tc.typecheck) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'devkit', 'typecheck')
		return tc.typecheck((await readProject(data(ctx), slug)).input)
	},
	install: async (ctx, { slug }) =>
		installDraft(fs, ctx.appId, slug, kernel(), await toolchain(), { onInstalled, overwrite }),
	pack: async (ctx, { slug }) => packDraft(data(ctx), slug, await toolchain()),
	run: async (ctx, { slug, reset }) => {
		const draft = await buildDraft(data(ctx), slug, await toolchain())
		const previewId = `preview.${slug}`
		if (draft.diagnostics.length || !draft.app || !draft.gui)
			return { previewId, diagnostics: draft.diagnostics } // keep last-good mount, uniform rule
		await runner.mount(draft, { appId: ctx.appId, slug, previewId, reset })
		return { previewId, diagnostics: [] }
	},
	stop: (_ctx, input) => runner.stop(input),
	menu: async (_ctx, input) => (await runner.menu?.(input)) ?? [], // default: no menus
	selectMenu: async (_ctx, input) => void (await runner.selectMenu?.(input)) // default: no-op
})
// data(ctx) = chroot(fs, `/data/${ctx.appId}`); readProject = today's `projectInput`.
```

### Final module map

- `packages/app/toolchain.ts` — was `engine.ts`. Exports the unified `Toolchain`
  + the pure types. **`Engine` is deleted.**
- `packages/app/toolchain.esbuild.ts` — was `engine.esbuild.ts`. Keeps
  `esbuildCompile` + `BuildFn`. **Deletes `esbuildEngine` and its local
  `Toolchain` type** (now imported from `toolchain.ts`).
- `packages/app/toolchain.typescript.ts` — was `engine.typescript.ts`.
  `typescriptEngine` → `typescriptToolchain`, returns `{ compile, typecheck }`.
- `packages/app/toolchain.bun.ts`, `toolchain.vfs.ts` — renamed from `engine.*`.
- `packages/app/devkit.ts` — slimmed pure pipeline: `DraftBuild`, `buildDraft`,
  `installDraft`, `packDraft`, `readProject` (exported for the factory).
  `compile`, `CompileEntries`, `entriesOf`, `compileDraft`, `typecheckDraft`
  become internal/removed; `tsconfigFor` stays (test helper). Re-export of
  `Toolchain`/`BuildFn` is dropped (import from `./toolchain*` directly).
- `packages/app/capabilities/devkit/host.ts` — **new**: `Runner`, `RunContext`,
  `noopRunner`, `devkitCapability`.
- `packages/app/capabilities/devkit/contract.ts` — unchanged (still the
  app-facing `DevkitCapability` + `MenuView`); its `import` path updates to
  `../../toolchain.ts`.

### package.json export changes (`packages/app/package.json`, both export blocks)

- Add `"./capabilities/devkit/host": "./capabilities/devkit/host.ts"` (+ the
  `publishConfig` `dist` twin).
- Rename `./engine*` → `./toolchain*` (`./toolchain`, `./toolchain/esbuild`,
  `./toolchain/bun`, `./toolchain/typescript`) in **both** the dev `exports` and
  the `publishConfig.exports` block.

---

## Steps (in dependency order, each independently verifiable)

> Run after each step: `pnpm format && pnpm typecheck && pnpm lint:fix && pnpm test`.
> Per `tsconfig.json`, the typecheck list must already include all four hosts.

### Step 1 — Unify the compile seam into one `Toolchain` type

Files: `packages/app/engine.ts`, `engine.esbuild.ts`, `engine.typescript.ts`,
`engine.bun.ts`, `devkit.ts`.

1. In `engine.ts`: replace `Engine` with
   `Toolchain = { compile: Compile; typecheck?(input): Promise<CheckResult> }`.
   Keep all other types.
2. In `engine.esbuild.ts`: delete the local `Toolchain = { compile }` and
   `esbuildEngine`; import `Toolchain` from `./engine.ts`. (`esbuildCompile`,
   `BuildFn` stay.)
3. In `engine.typescript.ts`: rename `typescriptEngine` → `typescriptToolchain`,
   return type `Toolchain` (`{ compile, typecheck }`). Same for `engine.bun.ts`
   if it exports an `*Engine`.
4. In `devkit.ts`: change `buildDraft`/`installDraft`/`packDraft` to accept
   `Toolchain` (source-compatible — they only use `.compile`). Replace
   `compileDraft`/`typecheckDraft` callers' type `Engine` → `Toolchain`.

Verify: `pnpm typecheck` will flag every host that imports `Engine`/
`esbuildEngine`/`typescriptEngine` — that is expected and is fixed in Steps 4–6.
To keep the tree green between steps, temporarily keep `esbuildEngine` and a
`type Engine = Toolchain` alias exported, and delete them in Step 7.

### Step 2 — Add the `Runner` seam + generic factory

File: **new** `packages/app/capabilities/devkit/host.ts`.

1. Define `RunContext`, `Runner`, `noopRunner`, and `devkitCapability(opts)` as
   specified above. Import `implementCapability` + `CapabilityError` from
   `../implement.ts`/`../error.ts` (or `../index.ts`), `devkit` from `./index.ts`,
   pipeline helpers + `DraftBuild` from `../../devkit.ts`, `Toolchain` from
   `../../engine.ts` (→ `../../toolchain.ts` after Step 7), `MenuView` from
   `./contract.ts`, `chroot`/`Volume` from `@justfiles/fs`, `Kernel` from
   `../../kernel.ts`.
2. Export `readProject` (today's private `projectInput`) from `devkit.ts` so the
   factory's `compile`/`typecheck` can call it.
3. Add the `./capabilities/devkit/host` entry to `package.json` (both blocks).

Verify: `pnpm typecheck`. No host uses it yet; this step only adds surface.

### Step 3 — Slim `devkit.ts`

File: `packages/app/devkit.ts`.

1. Inline `compile` (legacy adapter) into `buildDraft` (or keep private); remove
   it from exports. Make `CompileEntries`, `entriesOf` private.
2. Remove `compileDraft`/`typecheckDraft` (the factory now does this via
   `readProject` + `toolchain`). Keep `readProject`, `buildDraft`, `installDraft`,
   `packDraft`, `DraftBuild`, `tsconfigFor`.
3. Drop the `Toolchain`/`BuildFn` re-export.

Verify: `pnpm typecheck` flags the hosts/tests still importing the removed
symbols — fixed next.

### Step 4 — Migrate quay (`apps/quay/quayd/devkit.ts`)

1. Build one toolchain: `typescriptToolchain({ compile: await compileBackend(), ts })`
   (memoised), replacing the separate `engine()` + `toolchain()`.
2. Add a `quayRunner(fs, getKernel): Runner`: `mount` = today's `run` body
   (install hidden `preview.<slug>` into `getKernel()`, `reset` wipes
   `/state/${previewId}.json`); `stop` uninstalls. Omit `menu`/`selectMenu` —
   they're optional now, and the factory supplies the empty/no-op defaults that
   quay returns today.
3. `devkitCapability(fs, getKernel, onInstalled)` now returns
   `devkitCapability({ fs, toolchain, runner: quayRunner(fs, getKernel), kernel: getKernel, onInstalled, overwrite: true })`.
4. Update `host.ts` import if the signature/return changed (it stays a `Capability`).

Verify: `pnpm typecheck` + `pnpm test`. Smoke: install + pack a project in Code.

### Step 5 — Migrate desktop (`apps/desktop/src/main/devkit.ts`, `preview.ts`)

1. `preview.ts`: make `createPreviewManager` return a `Runner` — rename `run` →
   `mount(draft, ctx)` (drop the internal diagnostics guard; the factory
   guarantees a good draft), keep `stop`. Drop the `menu`/`selectMenu` no-op
   stubs — they're optional now and the factory defaults cover them.
2. `devkit.ts`: toolchain = `{ compile: (input) => esbuildCompile(input, build, runtime) }`
   (no `typecheck` → factory auto-degrades, matching today). Replace the
   hand-written `implementCapability` block with
   `devkitCapability({ fs, toolchain, runner: preview ?? noopRunner, kernel: getKernel, onInstalled, overwrite: false })`.
   Delete `fallbackRun` and the local `Preview` type (use shared `Runner`).

Verify: `pnpm typecheck` + `pnpm test`.

### Step 6 — Migrate frieren (`apps/frieren/src/apps/devkit.capability.ts`, `capabilities.client.ts`)

1. **New** `apps/frieren/src/apps/devkit.runner.ts`: `frierenRunner(fs, getToken): Runner`.
   `mount` = today's `run` body (scoped `createClientKernel`, install
   `preview.<slug>`, `host.close`/`open`, `reset` rm, mount into
   `[data-preview-slot]`); `stop` = `host.close`. Keep `menu`/`selectMenu` =
   today's `menu`/`selectMenu` — frieren is the only host that implements the
   (optional) menu surface, so its wiring is untouched.
2. Keep the lazy esbuild-wasm `getToolchain()` (now returns the unified
   `Toolchain` `{ compile }`, no `typecheck`).
3. In `capabilities.client.ts`: replace the hand-written devkit `invoke` lambda
   with `devkitCapability({ fs, toolchain: getToolchain, runner: frierenRunner(fs, getToken), kernel: () => createClientKernel({ fs, getToken }), onInstalled: host.notifyCatalog, overwrite: false })`,
   registered as the `devkit` capability. The lazy `import('./devkit.capability.ts')`
   becomes a direct construct (runner closures are cheap; esbuild-wasm stays
   lazy inside `getToolchain`).
4. **Delete** `invokeDevkit` and all `*Input` validators.

Verify: `pnpm typecheck` + `pnpm test`, then the frieren UI smoke check
(`pnpm run dev` + `pnpm run verify:ui`): open Code, run a draft → preview mounts;
edit → rebuild; install → appears in launcher.

### Step 7 — Rename `engine*` → `toolchain*` (mechanical, separate commit)

Files: `packages/app/engine.ts` → `toolchain.ts`, `engine.esbuild.ts` →
`toolchain.esbuild.ts`, `engine.typescript.ts`, `engine.bun.ts`, `engine.vfs.ts`;
`engine.test.ts`, `engine.bun.test.ts`.

1. `git mv` the files; update intra-package relative imports.
2. Rename `./engine*` → `./toolchain*` in `package.json` (both blocks).
3. Update external import paths: `@justfiles/app/engine` → `/toolchain`,
   `@justfiles/app/engine/esbuild` → `/toolchain/esbuild`,
   `@justfiles/app/engine/typescript` → `/toolchain/typescript` in quay, desktop,
   frieren.
4. Delete the temporary `Engine`/`esbuildEngine` compatibility aliases from
   Step 1.
5. Rename `docs/devkit-engine.md` → `docs/devkit-toolchain.md` and update it to
   describe `Toolchain` + `Runner` (the seam doc).

Verify: `pnpm typecheck` + `pnpm test` clean across all packages.

---

## Tests to touch

- `packages/app/engine.test.ts`, `engine.bun.test.ts`: `Engine` → `Toolchain`,
  `typescriptEngine` → `typescriptToolchain`; import path updated in Step 7. They
  use `tsconfigFor` from `devkit.ts` — keep it exported.
- `packages/app/devkit.test.ts`, `devkit.draft.test.ts`: drop any `compileDraft`/
  `typecheckDraft`/`compile` imports; assert via `buildDraft`/`packDraft` or the
  new factory. Add one test that drives `devkitCapability` with a fake `Toolchain`
  + `noopRunner` and asserts `compile`/`install`/`pack`/`typecheck`-degrade
  behaviour in one place (this is the payoff: capability behaviour is now
  host-agnostic and unit-testable).
- Root `__capcompile.test.ts` (untracked): reconcile or remove.

## Decisions already made

- **Names:** `Toolchain` (not `Compiler` — it also typechecks, and later
  lint/test) and `Runner` (not `Runtime` — `runtime` already means the bundled
  stdlib map the toolchain injects; `Launcher`/`Host` are also taken).
- **No third seam.** Packaging/install stays a generic factory body, not an
  injected interface — there is exactly one implementation (zip + `kernel.install`).
- **Build happens in the factory**, not the Runner; the Runner only receives a
  good `DraftBuild`. The "diagnostics → keep last-good, don't mount" rule lives
  once in the factory.
- **`typecheck` availability is data, not code**: present iff `toolchain.typecheck`
  is defined. Removes the per-host `CAPABILITY_UNAVAILABLE` boilerplate.
- **`Runner.menu`/`selectMenu` are optional + provisional.** Only frieren
  implements them; the factory supplies empty/no-op defaults so quay/desktop drop
  their stubs. They're a candidate for removal once we decide the live-preview
  menubar isn't worth keeping — making them optional now avoids disrupting
  frieren in the meantime. The app-facing `DevkitCapability` contract keeps
  `menu`/`selectMenu` for now (the factory always answers them).

## Risk / rollback

- Steps 1–6 are semantic and land behind temporary `Engine`/`esbuildEngine`
  aliases, so the tree stays green between them; Step 7 is a pure rename and can
  be reverted independently.
- Highest-risk host is frieren (live DOM mount). Gate it on the `verify:ui`
  smoke check before merging.

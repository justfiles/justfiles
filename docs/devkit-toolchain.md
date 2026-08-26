---
title: 'Devkit Toolchain'
description: One home for every devkit build/transform function (compile, typecheck, pack, install, lint, test) — a container on the server, the local backend on quay — with the live preview as the only client-side remainder.
---

# Devkit Toolchain

Devkit's functions split cleanly by one question: **is it a file transform, or is it
the running browser?**

- **File transforms** — `compile` (esbuild), `typecheck`, `pack`, `install`, later
  `lint` / `test` — are pure `files → artifact/diagnostics`. They all live in **one
  toolchain**: a **Container** on the server (frieren), the **local backend** on quay.
  The browser ships *none* of the toolchain — no esbuild-wasm, no TypeScript.
- **The running browser** — mounting the live preview, plus `stop` —
  runs the actual interactive app GUI in the user's DOM. It **cannot**
  leave the browser. It only *receives* a compiled bundle and mounts it.

This document specifies that toolchain. The motivating need was the agent's **typecheck**
(it edits draft code with no way to check its work — esbuild only strips types), but
the same toolchain owns the whole build/transform surface so the toolchain has **one
home per host**.

The hard constraint is **portability**: the agent runs server-side in a Cloudflare
**Durable Object** (frieren) with the Code app possibly closed, so the toolchain must run
without the browser. quay is easier (real Node backend). Both reach the *same* toolchain
behind the *same* interface.

## Implemented shape: `Toolchain` + `Runner` + a generic factory

In code this is two injected seams and one generic factory
(`packages/app/capabilities/devkit/host.ts`):

- **`Toolchain`** — the file-transform seam: `{ compile, typecheck? }`
  (`packages/app/toolchain.ts`). `typecheck` is optional; a host without a checker
  (browser esbuild-wasm) omits it and the factory degrades `typecheck` to
  `CAPABILITY_UNAVAILABLE`. Impls: `toolchain.esbuild.ts`, `toolchain.typescript.ts`,
  `toolchain.bun.ts`.
- **`Runner`** — the running-browser remainder: `{ mount, stop }`.
  The factory builds the draft and only ever calls `mount` with a clean build, so a
  Runner never re-checks diagnostics. `noopRunner` mounts nothing (compile-only hosts).
- **`devkitCapability({ fs, toolchain, runner, kernel, onInstalled?, overwrite? })`** —
  wires both seams into the full app-facing contract. A host supplies a Toolchain + a
  Runner and nothing else; the read-project / build / pack / install glue lives here once.

These types are **not** a separate package entry point: hosts reach them through
`@justfiles/app/capabilities/devkit/host` (the implementer surface) and app-facing
consumers through `@justfiles/app/capabilities/devkit` — the toolchain is internal to
the devkit capability, not a standalone module.

---

## The boundary

| devkit function                                           | Home                                             | Why                                                      |
|-----------------------------------------------------------|--------------------------------------------------|----------------------------------------------------------|
| `compile`, `typecheck`, `pack`, `install`, `lint`, `test` | **toolchain** — container (server) / backend (quay) | file transform: heavy deps, must run agent-in-background |
| preview `mount` / `stop`                                  | **client** (browser)                             | runs the live app GUI in the DOM — irreducible           |

`run` is the only function that spans both, so it **decomposes**:

```
run(slug)  =  toolchain.compile(slug) → outputs {app, gui}    // server (container / backend)
              then preview.mount(previewId, outputs)        // client (DOM, unchanged)
```

The compiled bundle (`app.js` + `gui.js`) is small, so shipping it to the client to
mount is cheap; the preview kernel still runs client-side from that bundle — only the
*compile step* moved off the browser. On quay both halves are one local process.

### The seam: one `Toolchain` interface, swappable impls

The swappable part is the **pure-transform sub-interface** — `compile` / `typecheck`
/ `lint` / `test`: `ProjectInput → result`, no fs, no DOM. Everything else composes
over it and is already client-capable: `pack` = `compile` + zip (fflate), `install` =
`compile` + a kernel write, `run` = `compile` + the client **preview mount** (outside
the seam entirely). So swapping the `Toolchain` changes the locus of *only*
`compile`/`typecheck`; the rest stay put.

That makes three impls behind one seam:

| `Toolchain` impl                  | `compile` / `pack` / `install` / `run` / `test` | `typecheck`                 | `lint`                   |
|--------------------------------|-------------------------------------------------|-----------------------------|--------------------------|
| **container** (frieren server) | ✅ native esbuild                               | ✅ `tsgo`                   | ✅ Biome                 |
| **node** (quay backend)        | ✅ esbuild                                      | ✅ `typescript`             | ✅ Biome                 |
| **browser** (esbuild-wasm)     | ✅ — proven today                               | ❌ `CAPABILITY_UNAVAILABLE` | ⚪ Biome WASM if shipped |

**The offline door stays open by construction.** Moving compile server-side is the
*default* (lean browser), but the browser esbuild path we have today is retained as a
valid **partial impl** behind the seam — online you wire the container-backed toolchain,
offline you fall back to the browser toolchain. The only function genuinely lost offline
is **`typecheck`** (the one 8 MB dep); it degrades via the existing
`CAPABILITY_UNAVAILABLE` mechanism (same as volume `system` scope), so the agent skips
it offline and the GUI grays out the Problems panel — no all-or-nothing cliff. (See
`platform/frieren/LOCAL_FIRST_PLAN.md`.)

**Discipline that keeps the seam clean:** the `Toolchain` interface stays
implementation-agnostic — pure data in/out, no fs, no subprocess, no slug-reading
(that's the host layer). The moment a method assumes a filesystem the browser impl
can't satisfy it and the seam leaks.

---

## Decision: a Container running native `tsgo` + esbuild, not a Worker

We compared running the toolchain (TypeScript ~8 MB + esbuild) in a **Worker** vs a
**Container**. The deciding factor:

- **Worker memory is a hard 128 MB per isolate** (JS heap + WASM combined),
  **not raisable**. TypeScript type-checking memory grows unbounded with project size
  (every `lib.d.ts` + `@types` + the program graph). It OOMs as apps grow — exactly
  the "bigger projects" worry — and an 8 MB `typescript.js` global-scope parse flirts
  with the **1 s startup limit**.
- **Containers** give **up to 12 GiB** (`standard-4`), run **native `tsgo`** (TS 7,
  ~10× faster) + native esbuild, no 8 MB JS parse, **scale to zero**, and `tsgo` is
  the **same binary quay's backend can run** → one toolchain, two hosts. Bursty agent
  cost is ~$0–2/mo (tunable via instance size + idle timeout); the only downside is a
  1–3 s cold start after idle, fine for a background agent.

So: **the toolchain's heavy compute lives in a Container**, the Durable Object calls it
over HTTP, the browser carries none of it. quay runs the same logic in-process.

---

## Architecture

The **toolchain** is the devkit host implementation (quay backend; frieren DO). It owns
every method. For heavy compute (esbuild bundle, tsc/tsgo check) it delegates to a
**stateless Container service**; the fs-touching parts (read the slug tree, write
`/applications`, zip) happen in the toolchain *around* that call.

```
┌─ agent tool ───────────┐   ┌─ app-code GUI ─────────────┐
│ capabilityTool(...)    │   │ actions.compile/typecheck  │   (callers)
└──────────┬─────────────┘   └──────────┬─────────────────┘
           │                            │
           ▼                            ▼
   ┌──────────────────────────────────────────────────────┐
   │  devkit TOOLCHAIN  (host impl: quay backend / frieren DO)│
   │  reads slug tree off the data Volume, orchestrates fs │
   │   compile · typecheck · pack · install · lint · test  │
   └───────────────┬───────────────────────┬──────────────┘
        in-process │ (quay)        over HTTP│ (frieren DO → container)
                   ▼                        ▼
        ┌────────────────────┐   ┌────────────────────────────┐
        │ typescript / esbuild│   │ CONTAINER: tsgo + esbuild  │
        │ run locally (Node)  │   │ POST /compile /typecheck   │
        └────────────────────┘   └────────────────────────────┘

   ┌──────────────────────────────────────────────┐
   │  PREVIEW host  (client, browser only)         │   receives { app, gui },
   │  mount · stop                                 │   mounts the isolate in the DOM
   └──────────────────────────────────────────────┘
```

The **interface** (below) is the contract every layer agrees on. The **toolchain** is
the only thing that differs per host. The **agent adapter** is identical everywhere.

---

## 1. The interface (priority 1)

A new module, e.g. `packages/app/toolchain.ts`, sibling to `devkit.ts`. Pure types + the
`Toolchain` interface — no toolchain impl, no host. (Mirrors how `compile()` is already a
pure function with an injected `Toolchain`.)

```ts
// ── positions: LSP-shaped, 0-based. Monaco/CodeMirror lint consume this directly,
//    and it's zero-conversion from ts.getLineAndCharacterOfPosition. The agent adapter
//    renders 1-based in its text summary (editors show humans 1-based).
export interface Position {
	line: number
	character: number
}
export interface Range {
	start: Position
	end: Position
}

// ── diagnostic: the LSP `Diagnostic` shape (= what tsserver's protocol emits), so ONE
//    shape normalises tsc, tsgo, esbuild and biome. `source` says which produced it.
export interface Diagnostic {
	file: string // project-relative path (key into ProjectInput.files; esbuild: location.file)
	range: Range
	severity: 'error' | 'warning' | 'info' // LSP 1/2/3; TS Suggestion + Message → 'info'
	source: string // 'ts' | 'tsgo' | 'esbuild' | 'biome'
	code?: string // 'TS2322' / a biome rule id (TS numeric → string)
	message: string // TS messageText chains flattened (ts.flattenDiagnosticMessageText)
	related?: { file: string; range: Range; message: string }[] // LSP relatedInformation / esbuild notes
	// later: tags?: ('unnecessary' | 'deprecated')[] — from TS reportsUnnecessary/reportsDeprecated
}

// ── compile output: esbuild's OutputFile shape (named + generic) — NOT hardcoded
//    app/gui. The manifest's entry names become the output paths; the preview picks
//    its bundles by those conventional names.
export interface OutputFile {
	path: string
	text: string
}
export interface CompileResult {
	outputs: OutputFile[]
	diagnostics: Diagnostic[]
}

// ── check output: just diagnostics (ok = none with severity 'error', derived).
export interface CheckResult {
	diagnostics: Diagnostic[]
}

// ── the project: a virtual file tree + named bundle entries + a standard tsconfig
//    generated from the manifest. `files`/`entries` mirror esbuild (entryPoints can be
//    a Record); `tsconfig` is the TS-ecosystem project definition (see tsconfigFor).
export interface ProjectInput {
	files: Record<string, string> // path → source (the vfs map)
	entries: Record<string, string> // outputName → entry path (esbuild entryPoints record)
	tsconfig: TsConfigJson // generated from the manifest; type-fest's zero-runtime type
}

// The heavy-compute primitives the Container exposes; the host toolchain composes the
// rest (pack = compile + zip; install = compile + kernel write) around them.
export interface Toolchain {
	compile(input: ProjectInput): Promise<CompileResult>
	typecheck(input: ProjectInput): Promise<CheckResult>
	// lint(input): Promise<CheckResult>   — later
	// test(input): Promise<TestResult>    — later
}
```

### Project shape: files + entries + a generated tsconfig

A draft is expressed the way the whole TS ecosystem expresses a project — a **file
tree + a `tsconfig.json`** — so every toolchain consumes it natively and nothing is
reinvented:

- **`files`** — the virtual source tree (a vfs map). **`entries`** — esbuild's named
  `entryPoints` in Record form (`{ app: 'src/app.ts', gui: 'src/gui.tsx' }`). The
  manifest's `app`/`gui` are just two conventional keys; the type is N-ary.
- **`tsconfig`** — a **standard `tsconfig.json` generated from the manifest** by a
  single helper, `tsconfigFor(manifest, types)` — the one home for our conventions
  (`strict`, `jsx: 'react-jsx'`, `moduleResolution: 'bundler'`, `lib`, `paths` → the
  `TypesBundle`, `noEmit`). `tsc` / `tsgo` consume it whole; esbuild honours the
  relevant subset via its `tsconfigRaw` option, so the bundle and the typecheck never
  disagree on jsx / paths / target.

This is the "follow tsconfig completely" path: the manifest stays author-facing sugar,
the generated tsconfig is the machine truth, and a future in-editor `tsserver` / LSP
would consume the very same config. (`TsConfigJson` is `type-fest`'s zero-runtime
type — don't hand-roll the schema.)

### The draft stdlib (one source of truth for both toolchains)

A draft lives in the user's Volume, **not** the workspace `node_modules`, so both the
bundler and the checker must be handed the stdlib the draft compiles against. esbuild
already uses a JS `runtime` map (`Record<specifier, jsText>`, built by
`devkit-runtime`); typecheck needs the **`.d.ts` analog**:

```ts
// `.d.ts` text for every bare specifier a draft may import. Built ONCE, from the SAME
// source as the JS runtime map, so the two can't drift (one stdlib, two projections:
// JS for esbuild, types for tsc/tsgo).
export type TypesBundle = Record<string, string>
//   '@justfiles/app/index.d.ts', '@justfiles/app/browser.d.ts',
//   'valibot/index.d.ts', 'react/index.d.ts', ... (+ a base tsconfig with `paths`)
```

`lib.*.d.ts` ships inside `typescript` / the `tsgo` image; the `TypesBundle` adds only
*our* surface. Headless `app.ts` checks against `es*`; `gui.tsx` adds `dom` + react.

### The host methods (so apps + the GUI can call them too)

Reshape `packages/app/capabilities/devkit/contract.ts`. Toolchain methods become
serializable (slug in, result out); the preview methods stay as-is but are understood
as the **client-only** remainder:

```ts
export interface DevkitCapability {
	// ── toolchain (server / backend) ────────────────────────────────────────────
	compile(input: { slug: string }): Promise<CompileResult>
	typecheck(input: { slug: string }): Promise<CheckResult>
	pack(input: { slug: string }): Promise<{ zip: Uint8Array }> // compile + zip
	install(input: { slug: string }): Promise<{ id: string }>   // compile + promote
	// lint / test — later

	// ── preview (client, browser only) ───────────────────────────────────────
	run(input: { slug: string; reset?: boolean }): Promise<{ previewId: string; diagnostics: Diagnostic[] }>
	// run = toolchain.compile(slug) → mount({ app, gui }); only `mount` is client-bound.
	stop(input: { previewId: string }): Promise<void>
}
```

The host toolchain reads the project tree like `buildDraft` does (`projectFiles` +
`entriesOf`), calls the `Toolchain`, and does the fs work (zip for `pack`,
`kernel.install` for `install`). The app-code GUI gets `actions.typecheck` /
`actions.compile` for a Problems panel; the agent gets them via the adapter (§3).

---

## 2. quay implementation (priority 2 — straightforward, Node backend)

quayd is real Node with `node_modules`, no portability limit and plenty of RAM, so
the toolchain runs **in-process**: the existing esbuild for `compile`, and the
**`typescript` compiler API** for `typecheck` — the minimal path, no subprocess.

```ts
// packages/app/toolchain.typescript.ts — portable JS checker. Runs in Node (quay) and,
// if ever needed, a Worker. createProgram over an in-memory CompilerHost backed by
// ProjectInput.files + the TypesBundle; map ts.Diagnostic → Diagnostic.
export function typescriptToolchain(opts: {
	build: BuildFn // existing esbuild toolchain (compile)
	ts: typeof import('typescript') // typecheck
	runtime: Record<string, string> // JS stdlib (esbuild)
	types: TypesBundle // .d.ts stdlib (tsc)
}): Toolchain
```

Wire in quayd:

1. Build the `TypesBundle` (a `verify-runtime` step beside `devkit-runtime`, from the
   same source).
2. Implement the `devkit` toolchain methods (`compile`/`typecheck`/`pack`/`install`)
   against `typescriptToolchain`.
3. Wire the app-code GUI to `actions.typecheck` / `actions.compile` (a Problems panel).

This lands the **toolchain + GUI path on a real backend** — the toolchain works and a
human sees diagnostics. quay is RAM-safe in-process, so it never needs tsgo (it *may*
adopt tsgo later for parity with the container — noted, not required). §3 then makes
the **agent** able to call it, which is what completes quay end-to-end.

---

## 3. Making capabilities available to agents (priority 3 — completes quay)

With the toolchain in place (§2), the agent gets to call it. This is the last piece for a
**complete quay**: the GUI already shows diagnostics; now the agent can typecheck its
own edits. The same adapter serves the container (§4) and frieren (§5) unchanged.

Today agents get:

- **Tools** — pi-agent-core `AgentTool` (`name`, `description`, TypeBox `parameters`,
  `execute`); e.g. `read`/`write`/`ls`, `fetch`, `search`.
- **The `app` command** — `createAppCommand(controller)`: a host-injected
  `AppController` surfaced as a bash subcommand. Already a **host-service → agent**
  bridge, just hand-written and CLI-shaped.
- **Skills** — markdown bodies expanded into a turn. *Not* a way to call a capability,
  just extra instructions. (Agreed: wrong tool here.)

### Recommendation: a thin, opt-in `capabilityTool` adapter

A capability method is *already tool-shaped*: a single serializable object in, a
serializable value out. The only thing missing for the LLM is **runtime metadata** —
description, params JSON-schema, examples — because the TS interface erases at
runtime. The app framework **already solved this** for app actions: `t.on(schema, …,
{ description, examples })` → `ActionMeta { description, schemaHint, examples }` is the
agent's UI for an action. Reuse that convention for capabilities:

```ts
// packages/agent — generalises the `app` command's controller→agent pattern into a
// reusable adapter. One small function; the host supplies metadata + a bound invoke.
export interface CapabilityToolSpec<I> {
	name: string
	description: string // what it does + when to use it — the agent's UI
	parameters: TSchema // TypeBox; becomes the tool's param schema
	examples?: { params: I }[]
	invoke(input: I): Promise<unknown> // bound to the real host toolchain method
}

export function capabilityTool<I>(spec: CapabilityToolSpec<I>): AgentTool
//  execute = validate input → invoke → serialise result; CapabilityError → tool error.
```

Wiring `typecheck` (quay `agent.ts`, identical pattern in frieren):

```ts
const tools = [
	...fsTools.tools,
	createFetchTool(),
	createSearchTool(),
	bash,
	askUser,
	capabilityTool({
		name: 'typecheck',
		description:
			'Type-check the current app project. Returns diagnostics (file, line, message). Run after editing app source, before considering a change done.',
		parameters: Type.Object({ slug: Type.String() }),
		examples: [{ params: { slug: 'my-notes' } }],
		invoke: ({ slug }) => devkit.typecheck({ slug })
	})
]
```

With §2's toolchain + this adapter, **quay is complete end-to-end**: the GUI shows
diagnostics and the agent can typecheck its own edits before calling a change done.

### Why this shape

- **Not skills** — they inject instructions, can't *call* anything. ✗
- **Not bespoke per-capability commands** (like `app`) — every capability would
  re-hand-write CLI parsing + formatting + error mapping. Doesn't scale. ✗
- **Not auto-reflection over the contract** — types erase (no schema/description), and
  blanket-exposing every method is a footgun (volume `system` scope, destructive
  ops). ✗
- **Descriptor-driven, opt-in adapter** — minimal (one function), reuses the
  established schema+description+examples convention, **opt-in per method** (mirroring
  procedures' `audience: 'agent'`). ✓

### Security note

The agent is a **trusted host actor**, not a sandboxed app, so `capabilityTool` calls
the host impl directly — it does **not** go through the kernel's scope mediation (same
as `app` dispatching straight into the kernel). The gate is **exposure**: only methods
the host explicitly wraps become agent tools. Default is "not exposed." Keep the
wrapped set stingy.

---

## 4. The Container (priority 4 — native toolchain)

One small image = the shared compute service. Inside it runs the **native toolchain**:

```ts
// packages/app/toolchain.native.ts — esbuild (native) for compile; tsgo for typecheck.
// Write ProjectInput.files into a tmp workdir beside the baked TypesBundle + a
// generated tsconfig, spawn the tools, parse output → CompileResult / CheckResult.
export function nativeToolchain(opts: { esbuild: BuildFn; tsgoBin: string; typesDir: string; spawn; tmp }): Toolchain
```

Image contents:

- native **esbuild** + **`tsgo`** (`@typescript/native-preview`).
- the baked `TypesBundle` as a types dir + base `tsconfig.json` (`strict`, `jsx`,
  `paths`, `noEmit`).
- a tiny HTTP handler: `POST /compile`, `POST /typecheck` (`{ files, entries } →
  result`); `lint` / `test` join the same surface later.

Deployment:

- **Instance type:** start at `basic` (1 GiB — already 8× a Worker); size up to
  `standard-1/-2` only if a project needs it.
- **Lifecycle:** DO-managed via the [Container API], **scale-to-zero** with a short
  idle timeout (~30–60 s). First call after idle eats the 1–3 s cold start; bursts
  stay warm.

[Container API]: https://developers.cloudflare.com/durable-objects/api/container/

---

## 5. Connect frieren (priority 5 — DO → container)

frieren's `devkit` routes by the boundary above:

- **toolchain methods** (`compile` / `typecheck` / `pack` / `install`) → **DO → container**.
- **preview methods** (`run`'s mount, `stop`) → **client**.

The agent tool from §3 is reused unchanged — only its `invoke` now reaches the DO's
container instead of an in-process toolchain.

Agent `typecheck` flow (entirely server-side):

1. Agent (in the DO) edits files in the mirrored fs via its `write` tool.
2. Agent calls the `typecheck` tool → toolchain `devkit.typecheck({ slug })`.
3. The DO reads the slug tree off the **already-mirrored** Volume (files leave the DO
   only to its container) and `POST`s `{ files, entries }` to the container.
4. Container runs `tsgo`, returns `CheckResult`.
5. The DO writes diagnostics into app state / fs → the client, *if connected*, sees
   them via normal sync. **No reverse client→server RPC; works with the app closed.**

Interactive `run` flow:

1. Client clicks Run → request reaches the DO.
2. DO calls `container.compile({ files, entries })` → `{ app, gui }`.
3. DO returns the bundle to the client → client **mounts** it into
   `[data-preview-slot]` (the only client-bound step). `install` / `pack` are the same
   first two steps, then a DO-side fs write / zip — no client involved, so they run
   with the app closed.

---

## 6. Future: lint and unit test

Both slot into the same toolchain with no architectural change:

- **lint** — `Toolchain.lint(input): CheckResult` (reuses `Diagnostic`). Native **Biome**
  in the container (rule parity with `pnpm lint`), exposed as `devkit.lint` + a
  `capabilityTool`. Optional; esbuild + typecheck already catch most real problems.
- **test** — `Toolchain.test(input): TestResult`. App `app.ts` is a pure state machine, so
  a unit test = dispatch actions → assert state. Run the compiled app in the existing
  isolate/kernel with a tiny injected `test()`/`expect()` shim; no vitest (Node-only)
  in the portable path. Exposed as `devkit.test` + a `capabilityTool`.

---

## Build order (recap)

1. **Interface** — `toolchain.ts` (`Toolchain`, `ProjectInput`, `CompileResult`,
   `CheckResult`, `Diagnostic`, `TypesBundle`) + the reshaped `devkit` contract
   (toolchain methods vs preview).
2. **quay toolchain + GUI** — `typescriptToolchain` in-process + the `TypesBundle` build +
   the toolchain host methods + the app-code Problems panel.
3. **Agent adapter (completes quay)** — the `capabilityTool` adapter in
   `packages/agent` + wire `typecheck` as a quay agent tool. quay now works end-to-end.
4. **Container** — image with native esbuild + `tsgo` + baked `TypesBundle` +
   `POST /compile /typecheck`; `nativeToolchain`; DO-managed scale-to-zero.
5. **frieren** — route toolchain methods DO → container; `run` = container compile +
   client mount; reuse the §3 agent tool; diagnostics into state → client via sync.

## Open questions

- **Offline browser toolchain** — *decided* to keep the door open: the browser
  esbuild path is retained as a partial `Toolchain` impl (everything but `typecheck`).
  Open: do we wire it as an automatic offline fallback now, or leave the code in
  place and wire it only if offline proves desirable? Lean: leave it, wire later.
- **Diagnostic parity** quay (`typescript`) vs container (`tsgo`, ~TS 6.0 semantics) —
  acceptable, or standardise on `tsgo` everywhere later?
- **`TypesBundle` freshness** — must track the shipped `@justfiles/app` surface; build
  it from the same source as `devkit-runtime` so they can't drift.
- **One container per what** — per Code session / per user DO? Start per-DO,
  scale-to-zero; revisit if idle containers cost too much warm memory.
- **`run` orchestration on frieren** — client-initiated request to the DO, or
  sync-mediated? Interactive (client is open), so a direct request is acceptable;
  confirm it fits the sync model when wiring §5.

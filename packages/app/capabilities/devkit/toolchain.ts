// The devkit TOOLCHAIN types: the pure file-transform surface (compile, typecheck
// — later lint/test) shared by every host. It is the swappable source→artifact
// seam of the build pipeline (see `docs/devkit-toolchain.md`): `ProjectInput →
// result`, no fs, no DOM, no subprocess, no slug-reading. Hosts compose the rest
// (pack = compile + zip, install = compile + kernel write, the live-preview mount)
// AROUND this seam, so swapping the toolchain moves only `compile`/`typecheck` and
// the browser-bound preview stays put.
//
// Three impls live behind the seam: a Container running native esbuild + `tsgo`
// (frieren server), the `typescript` compiler API in-process (quay Node backend),
// and the browser esbuild-wasm path as a partial impl (no `typecheck`).
//
// Pure types only — no impl, no host; and not its own package entry point: hosts
// reach these through `@justfiles/app/capabilities/devkit/host`. The discipline
// that keeps the seam clean: the moment a method assumes a filesystem, the browser
// impl can't satisfy it and the seam leaks.

import type { TsConfigJson } from 'type-fest'

// ── positions: LSP-shaped, 0-based. Monaco/CodeMirror lint consume this
//    directly, and it's zero-conversion from `ts.getLineAndCharacterOfPosition`.
//    The agent adapter renders 1-based in its text summary (editors show humans
//    1-based).
export interface Position {
	line: number
	character: number
}
export interface Range {
	start: Position
	end: Position
}

// ── diagnostic: the LSP `Diagnostic` shape (= what tsserver's protocol emits),
//    so ONE shape normalises tsc, tsgo, esbuild and biome. `source` says which
//    produced it.
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
//    app/gui. The manifest's entry names become the output paths; the preview
//    picks its bundles by those conventional names.
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

// `.d.ts` text for every bare specifier a draft may import — the type analog of
// the JS `runtime` map esbuild consumes. Built ONCE, from the SAME source as the
// JS runtime map (`devkit-runtime`), so the two can't drift: one stdlib, two
// projections (JS for esbuild, types for tsc/tsgo). `lib.*.d.ts` ships inside
// `typescript` / the `tsgo` image; the `TypesBundle` adds only our surface
// (`@justfiles/app/*`, `valibot`, `react`, … + a base tsconfig with `paths`).
export type TypesBundle = Record<string, string>
//   '@justfiles/app/index.d.ts', '@justfiles/app/browser.d.ts',
//   'valibot/index.d.ts', 'react/index.d.ts', ...

// The tsc import-map (`compilerOptions.paths`): an SDK specifier → its entry `.d.ts`
// in the type overlay. The type analog of the runtime `spec → js` map, built from the
// SAME source — so tsc resolves our SDK by explicit lookup instead of walking a faked
// `node_modules`. Values are overlay-root-relative (the typecheck host sets `baseUrl`).
export type TypePaths = Record<string, string[]>
//   '@justfiles/app': ['node_modules/@justfiles/app/dist/index.d.ts'], ...

// ── the project: a virtual file tree + named bundle entries + a standard
//    tsconfig generated from the manifest. `files`/`entries` mirror esbuild
//    (entryPoints can be a Record); `tsconfig` is the TS-ecosystem project
//    definition. Every toolchain consumes this natively — nothing is reinvented.
export interface ProjectInput {
	files: Record<string, string> // path → source (the vfs map)
	entries: Record<string, string> // outputName → entry path (esbuild entryPoints record)
	tsconfig: TsConfigJson // generated from the manifest; type-fest's zero-runtime type
}

// The bundler-agnostic compile seam (= `Toolchain['compile']`): a `ProjectInput →
// CompileResult` step with the system `runtime` already closed into the closure.
// This is what the host injects — the esbuild adapter (native / wasm) and the Bun
// adapter both produce one — so the build/pack pipeline never names a bundler.
export type Compile = (input: ProjectInput) => Promise<CompileResult>

// The build/compile seam every host injects — the swappable source→artifact end of
// the devkit pipeline. `typecheck` is OPTIONAL: a host with no type checker
// (browser esbuild-wasm, desktop) omits it and the devkit factory degrades
// `typecheck` to CAPABILITY_UNAVAILABLE; a Node host (quay) supplies it. lint/test
// slot in later with no change. This type is not exported from the package as its
// own entry point — it reaches hosts via `@justfiles/app/capabilities/devkit/host`.
export interface Toolchain {
	compile: Compile
	typecheck?(input: ProjectInput): Promise<CheckResult>
	// lint(input): Promise<CheckResult>   — later
	// test(input): Promise<TestResult>    — later
}

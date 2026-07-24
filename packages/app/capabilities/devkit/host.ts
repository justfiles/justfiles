// The generic devkit host: how a host implements the `devkit` capability. A host
// injects only the backend-specific pieces —
//
//   • `compile(input, runtime)`         (its bundler: esbuild native / wasm / Bun),
//   • `typecheck?(input, types, paths)`  (its type checker: tsc — optional), and
//   • a `Runner`                         (how to make a built draft live).
//
// — and `devkitCapability` does the rest: for each calling app it loads THAT app's
// installed devkit sysroot (`devkit/**`) through the kernel, binds the backends to
// it, and wires the full contract (read the project, build, guard diagnostics,
// pack/zip, install into the kernel). This mirrors a real platform: a swappable
// toolchain (clang / d8 / tsc) and a swappable loader/runtime (dyld / ART / a
// WebContentsView), with a manifest-driven orchestrator that knows neither between.

import { chroot, type Volume } from '@justfiles/fs'
import type { Kernel } from '../../kernel.ts'
import { CapabilityError } from '../error.ts'
import { implementCapability } from '../implement.ts'
import type { Capability } from '../types.ts'
import type { DevkitPreview } from './contract.ts'
import { buildDraft, type DraftBuild, installDraft, packDraft, readProject } from './devkit.ts'
import { loadRuntime, loadTypes } from './devkit-sysroot.ts'
import { devkit, previewIdFor } from './index.ts'
import type {
	CheckResult,
	Compile,
	CompileResult,
	ProjectInput,
	Toolchain,
	TypePaths,
	TypesBundle
} from './toolchain.ts'

// The compiled-draft shape a `Runner` receives at `mount` — re-exported here so a
// host implements `devkit` (and types its Runner) from this one surface, with no
// separate `@justfiles/app/devkit` import.
export type { DraftBuild } from './devkit.ts'
// The toolchain type vocabulary, re-exported so a host implements `devkit` from
// this one surface — the seam types it injects (`Toolchain`, `Compile`,
// `ProjectInput`, `TypesBundle`) plus the result types those produce — with no
// separate engine/toolchain entry point.
export type {
	CheckResult,
	Compile,
	CompileResult,
	Diagnostic,
	OutputFile,
	Position,
	ProjectInput,
	Range,
	Toolchain,
	TypesBundle
} from './toolchain.ts'

// What the factory hands a `Runner` when it mounts a draft: the build's identity
// plus the `.preview.<slug>` id the factory computed. The factory only ever calls
// `mount` with a GOOD build (it guards diagnostics itself), so a Runner never
// re-checks them.
export interface RunContext {
	appId: string
	slug: string
	previewId: string // `.preview.${slug}` — hidden id, see below
	reset?: boolean
}

// The launch seam: make a built draft live, and tear it down.
export interface Runner {
	mount(draft: DraftBuild, ctx: RunContext): Promise<DevkitPreview | undefined>
	stop(input: { previewId: string }): Promise<void>
}

// A Runner that mounts nothing — for compile-only hosts (and tests). `run` still
// compiles + reports diagnostics; it just never makes a draft live.
export const noopRunner: Runner = {
	mount: async () => undefined,
	stop: async () => {}
}

// Implement the `devkit` capability from two backend functions + a runner. The
// factory is caller-aware: every method threads the calling app's id (`ctx.appId`,
// e.g. Code = `app.justfiles.frieren.code`, never hardcoded) so the right app's sysroot loads. The
// per-app toolchain is built lazily and cached — a session that never builds loads
// no sysroot. `compile(input, runtime)` is required; `typecheck(input, types,
// paths)` is optional (omit it → the factory degrades typecheck to
// CAPABILITY_UNAVAILABLE and never loads the `.d.ts` overlay). `kernel` is the
// kernel this capability is registered in — the SYSTEM injects it (kernel.ts calls
// the host's capability factory with itself), so it's always the right instance,
// used for BOTH the per-app sysroot reads and install/pack (a Runner owns its own
// preview kernel). `overwrite` lets quay ship-or-update; frieren is create-only.
export function devkitCapability(opts: {
	fs: Volume
	compile: (input: ProjectInput, runtime: Record<string, string>) => Promise<CompileResult>
	typecheck?: (input: ProjectInput, types: TypesBundle, paths: TypePaths) => Promise<CheckResult>
	runner: Runner
	kernel: Kernel
	overwrite?: boolean
}): Capability {
	const { fs, compile, typecheck, runner, kernel, overwrite } = opts
	// The caller's own data dir — where `projects/<slug>` lives.
	const data = (ctx: { appId: string }) => chroot(fs, `/data/${ctx.appId}`)
	// Per-app toolchain: load THAT caller's installed devkit sysroot through the
	// kernel + `ctx.appId`, then bind the injected backends to it. Runtime always;
	// the `.d.ts` overlay + import-map only when a `typecheck` backend is wired.
	// Cached for the capability's life (the pipeline below calls it per method).
	const toolchains = new Map<string, Promise<Toolchain>>()
	const toolchain = (ctx: { appId: string }): Promise<Toolchain> => {
		let tc = toolchains.get(ctx.appId)
		if (!tc) {
			tc = (async () => {
				const installed = await kernel.app(ctx.appId)
				const read = (path: string) => installed.read(path)
				const runtime = await loadRuntime(read)
				const compileStep: Compile = (input) => compile(input, runtime)
				if (!typecheck) return { compile: compileStep }
				const { files, paths } = await loadTypes(read)
				return { compile: compileStep, typecheck: (input) => typecheck(input, files, paths) }
			})()
			toolchains.set(ctx.appId, tc)
		}
		return tc
	}
	return implementCapability(devkit, {
		compile: async (ctx, { slug }) =>
			(await toolchain(ctx)).compile((await readProject(data(ctx), slug)).input),
		typecheck: async (ctx, { slug }) => {
			const tc = await toolchain(ctx)
			if (!tc.typecheck) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'devkit', 'typecheck')
			return tc.typecheck((await readProject(data(ctx), slug)).input)
		},
		// Promote the draft to the real `/applications`. The kernel emits
		// `app.installed` on success; a host that must react (re-list a launcher,
		// re-materialise an OS bundle) subscribes to that, off this call path.
		install: async (ctx, { slug }) =>
			installDraft(fs, ctx.appId, slug, kernel, await toolchain(ctx), { overwrite }),
		pack: async (ctx, { slug }) => packDraft(data(ctx), slug, await toolchain(ctx)),
		// Compile, then (only on a clean build) hand the draft to the runner. On a
		// compile error the last-good mount stays put — one uniform rule, here.
		run: async (ctx, { slug, reset }) => {
			const draft = await buildDraft(data(ctx), slug, await toolchain(ctx))
			// A hidden kernel id (leading dot): the preview installs + serves like any
			// app but stays off the catalog surface, so preview churn on every ⟳ Run
			// never wakes a launcher.
			const previewId = previewIdFor(slug)
			if (draft.diagnostics.length > 0 || !draft.app || !draft.gui)
				return { previewId, diagnostics: draft.diagnostics }
			const preview = await runner.mount(draft, { appId: ctx.appId, slug, previewId, reset })
			return { previewId, diagnostics: [], ...(preview ? { preview } : {}) }
		},
		stop: (_ctx, input) => runner.stop(input)
	})
}

// The generic devkit host: how a host implements the `devkit` capability. It
// injects two seams and nothing else —
//
//   • a `Toolchain` (how to compile/typecheck — `../../toolchain.ts`), and
//   • a `Runner`   (how to make a built draft live — mount/stop/menu).
//
// — and `devkitCapability` wires them through `implementCapability` into the
// full app-facing contract. Everything in between (read the project, build,
// guard diagnostics, pack/zip, install into the kernel) is generic pipeline,
// owned here once. This mirrors a real platform: a swappable toolchain (clang /
// d8 / tsc) and a swappable loader/runtime (dyld / ART / a WebContentsView),
// with a manifest-driven orchestrator that knows neither in between.

import { chroot, type Volume } from '@justfiles/fs'
import { buildDraft, type DraftBuild, installDraft, packDraft, readProject } from '../../devkit.ts'
import type { Kernel } from '../../kernel.ts'
import type { Toolchain } from '../../toolchain.ts'
import { CapabilityError } from '../error.ts'
import { implementCapability } from '../implement.ts'
import type { Capability } from '../types.ts'
import type { MenuView } from './contract.ts'
import { devkit } from './index.ts'

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
} from '../../toolchain.ts'

// What the factory hands a `Runner` when it mounts a draft: the build's identity
// plus the `preview.<slug>` id the factory computed. The factory only ever calls
// `mount` with a GOOD build (it guards diagnostics itself), so a Runner never
// re-checks them.
export interface RunContext {
	appId: string
	slug: string
	previewId: string // `preview.${slug}`
	reset?: boolean
}

// The launch seam: make a built draft live, and tear it down. `menu`/`selectMenu`
// are OPTIONAL and provisional — only frieren drives a live-preview menubar
// today, and we may drop them entirely; a host that omits them gets the factory's
// safe defaults (empty menu / no-op).
export interface Runner {
	mount(draft: DraftBuild, ctx: RunContext): Promise<void>
	stop(input: { previewId: string }): Promise<void>
	menu?(input: { previewId: string }): Promise<MenuView>
	selectMenu?(input: { previewId: string; menu: number; item: number }): Promise<void>
}

// A Runner that mounts nothing — for compile-only hosts (and tests). `run` still
// compiles + reports diagnostics; it just never makes a draft live.
export const noopRunner: Runner = {
	mount: async () => {},
	stop: async () => {}
}

// Implement the `devkit` capability from a toolchain + a runner. `toolchain` is
// lazy (a session that never builds pays nothing); `kernel` is the SHIP kernel
// for install/pack (a Runner owns its own preview kernel). `overwrite` lets quay
// ship-or-update; frieren/desktop create-only.
export function devkitCapability(opts: {
	fs: Volume
	toolchain: () => Promise<Toolchain>
	runner: Runner
	kernel: () => Kernel
	onInstalled?: () => void | Promise<void>
	overwrite?: boolean
}): Capability {
	const { fs, toolchain, runner, kernel, onInstalled, overwrite } = opts
	// The caller's own data dir — where `projects/<slug>` lives.
	const data = (ctx: { appId: string }) => chroot(fs, `/data/${ctx.appId}`)
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
		// Compile, then (only on a clean build) hand the draft to the runner. On a
		// compile error the last-good mount stays put — one uniform rule, here.
		run: async (ctx, { slug, reset }) => {
			const draft = await buildDraft(data(ctx), slug, await toolchain())
			const previewId = `preview.${slug}`
			if (draft.diagnostics.length > 0 || !draft.app || !draft.gui)
				return { previewId, diagnostics: draft.diagnostics }
			await runner.mount(draft, { appId: ctx.appId, slug, previewId, reset })
			return { previewId, diagnostics: [] }
		},
		stop: (_ctx, input) => runner.stop(input),
		menu: async (_ctx, input) => (await runner.menu?.(input)) ?? [],
		selectMenu: async (_ctx, input) => void (await runner.selectMenu?.(input))
	})
}

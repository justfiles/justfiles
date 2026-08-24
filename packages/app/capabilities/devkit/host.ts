// The shared Devkit host loads the calling app's platform SDK and the project's
// URL imports. Hosts supply the compiler, optional type checker, cache, and runner.

import { chroot, type Volume } from '@justfiles/fs'
import type { Kernel } from '../../kernel.ts'
import { CapabilityError } from '../error.ts'
import { implementCapability } from '../implement.ts'
import type { Capability } from '../types.ts'
import type { DevkitPreview } from './contract.ts'
import {
	buildDraft,
	type DevkitProject,
	type DraftBuild,
	installDraft,
	packDraft,
	readProject,
	writeImportLock
} from './devkit.ts'
import { loadRuntime, loadTypes } from './devkit-sysroot.ts'
import { type ImportCache, type ResolvedImports, resolveImports } from './imports.ts'
import { devkit, previewIdFor } from './index.ts'
import type {
	CheckResult,
	Compile,
	CompileResult,
	Diagnostic,
	ProjectInput,
	Toolchain,
	TypePaths,
	TypesBundle
} from './toolchain.ts'

// The compiled-draft shape a `Runner` receives at `mount` — re-exported here so a
// host implements `devkit` (and types its Runner) from this one surface, with no
// separate `@justfiles/app/devkit` import.
export type { DraftBuild } from './devkit.ts'
export type { ImportCache, ResolvedImports } from './imports.ts'
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

type CompileBackend = (
	input: ProjectInput,
	runtime: Record<string, string>,
	imports?: ResolvedImports
) => Promise<CompileResult>

type TypecheckBackend = (
	input: ProjectInput,
	types: TypesBundle,
	paths: TypePaths,
	imports?: ResolvedImports
) => Promise<CheckResult>

// The platform SDK and project import graph load on first use. Type checking stays
// optional so a compile-only host does not load declarations or TypeScript.
export function devkitCapability(opts: {
	fs: Volume
	compile: CompileBackend
	typecheck?: TypecheckBackend
	imports?: { cache: ImportCache; fetch?: typeof fetch }
	runner: Runner
	kernel: Kernel
	overwrite?: boolean
}): Capability {
	const { fs, compile, typecheck, imports: importHost, runner, kernel, overwrite } = opts
	// The caller's own data dir — where `projects/<slug>` lives.
	const data = (ctx: { appId: string }) => chroot(fs, `/data/${ctx.appId}`)
	// A project owns one import graph, lock, and preview. Run its calls one at a time.
	const jobs = new Map<string, Promise<unknown>>()
	const runProject = <T>(
		ctx: { appId: string },
		previewId: string,
		job: () => Promise<T>
	): Promise<T> => {
		const id = `${ctx.appId}\0${previewId}`
		const next = (jobs.get(id) ?? Promise.resolve()).catch(() => {}).then(job)
		jobs.set(id, next)
		return next.finally(() => {
			if (jobs.get(id) === next) jobs.delete(id)
		})
	}
	// Each installed App Code version supplies its own SDK. Keep that fixed input
	// apart from project imports so a project cannot replace a platform module.
	const platforms = new Map<
		string,
		Promise<{ runtime: Record<string, string>; types?: TypesBundle; paths?: TypePaths }>
	>()
	const platformFor = (ctx: { appId: string }) => {
		let value = platforms.get(ctx.appId)
		if (!value) {
			value = (async () => {
				const installed = await kernel.app(ctx.appId)
				const read = (path: string) => installed.read(path)
				const runtime = await loadRuntime(read)
				if (!typecheck) return { runtime }
				const { files, paths } = await loadTypes(read)
				return { runtime, types: files, paths }
			})()
			platforms.set(ctx.appId, value)
		}
		return value
	}

	type ImportSession = {
		map: string
		lock?: string
		graph: Promise<ResolvedImports>
	}
	const sessions = new Map<string, ImportSession>()
	const sessionFor = (
		ctx: { appId: string },
		slug: string,
		project: DevkitProject
	): ImportSession | undefined => {
		if (!importHost || Object.keys(project.imports).length === 0) return
		const id = `${ctx.appId}\0${slug}`
		const map = JSON.stringify(project.imports)
		const lock = project.lock ? JSON.stringify(project.lock) : undefined
		let session = sessions.get(id)
		if (!session || session.map !== map || session.lock !== lock) {
			session = {
				map,
				lock,
				graph: resolveImports(project.imports, {
					cache: importHost.cache,
					fetch: importHost.fetch,
					lock: project.lock,
					frozen: false
				})
			}
			sessions.set(id, session)
		}
		return session
	}

	const prepare = async (
		ctx: { appId: string },
		slug: string
	): Promise<{ project: DevkitProject; toolchain: Toolchain }> => {
		const project = await readProject(data(ctx), slug)
		const platform = await platformFor(ctx)
		const declared = Object.keys(project.imports).length > 0
		const session = sessionFor(ctx, slug, project)
		const imports = session ? await session.graph : undefined
		if (session && imports?.diagnostics.length) sessions.delete(`${ctx.appId}\0${slug}`)
		const unavailable = declared && !imports ? [importUnavailable()] : []
		const blocked = [...unavailable, ...(imports?.diagnostics ?? [])]
		const save = async () => {
			if (!session || !imports || imports.diagnostics.length > 0) return
			const lock = imports.lock()
			await writeImportLock(data(ctx), slug, lock)
			session.lock = JSON.stringify(lock)
		}
		const compileStep: Compile = async (input) => {
			if (blocked.length > 0) return { outputs: [], diagnostics: blocked }
			const result = await compile(input, platform.runtime, imports)
			await save()
			return result
		}
		const toolchain: Toolchain = { compile: compileStep }
		if (typecheck) {
			toolchain.typecheck = async (input) => {
				if (blocked.length > 0) return { diagnostics: blocked }
				const result = await typecheck(input, platform.types ?? {}, platform.paths ?? {}, imports)
				await save()
				return result
			}
		}
		return { project, toolchain }
	}

	return implementCapability(devkit, {
		compile: (ctx, { slug }) =>
			runProject(ctx, previewIdFor(slug), async () => {
				const { project, toolchain } = await prepare(ctx, slug)
				return toolchain.compile(project.input)
			}),
		typecheck: (ctx, { slug }) =>
			runProject(ctx, previewIdFor(slug), async () => {
				const { project, toolchain } = await prepare(ctx, slug)
				if (!toolchain.typecheck)
					throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'devkit', 'typecheck')
				return toolchain.typecheck(project.input)
			}),
		// Promote the draft to the real `/applications`. The kernel emits
		// `app.installed` on success; a host that must react (re-list a launcher,
		// re-materialise an OS bundle) subscribes to that, off this call path.
		install: (ctx, { slug }) =>
			runProject(ctx, previewIdFor(slug), async () => {
				const { project, toolchain } = await prepare(ctx, slug)
				return installDraft(fs, ctx.appId, slug, kernel, toolchain, { overwrite, project })
			}),
		pack: (ctx, { slug }) =>
			runProject(ctx, previewIdFor(slug), async () => {
				const { project, toolchain } = await prepare(ctx, slug)
				return packDraft(data(ctx), slug, toolchain, project)
			}),
		// Compile, then (only on a clean build) hand the draft to the runner. On a
		// compile error the last-good mount stays put — one uniform rule, here.
		run: (ctx, { slug, reset }) => {
			const previewId = previewIdFor(slug)
			return runProject(ctx, previewId, async () => {
				const { project, toolchain } = await prepare(ctx, slug)
				const draft = await buildDraft(data(ctx), slug, toolchain, project)
				// A hidden kernel id (leading dot): the preview installs + serves like any
				// app but stays off the catalog surface, so preview churn on every ⟳ Run
				// never wakes a launcher.
				if (draft.diagnostics.length > 0 || !draft.app || !draft.gui)
					return { previewId, diagnostics: draft.diagnostics }
				const preview = await runner.mount(draft, { appId: ctx.appId, slug, previewId, reset })
				return { previewId, diagnostics: [], ...(preview ? { preview } : {}) }
			})
		},
		stop: (ctx, input) => runProject(ctx, input.previewId, () => runner.stop(input))
	})
}

function importUnavailable(): Diagnostic {
	return {
		file: '',
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
		severity: 'error',
		source: 'imports',
		code: 'IMPORT_UNAVAILABLE',
		message: 'This host does not support project URL imports.'
	}
}

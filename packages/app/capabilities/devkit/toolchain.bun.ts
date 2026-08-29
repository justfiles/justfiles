// The Bun adapter of the devkit toolchain: a `Bun.build` plugin + options over the
// same bundler-agnostic vfs rules as `toolchain.esbuild.ts`. Runs only under Bun
// (`Bun.build` is in the runtime — see the migration spike), so it's selected via
// the `#engine` runtime condition and never imported under Node. Same virtual
// `runtime` injection (nothing external), same `app.js`/`gui.js` output shape.
// `.css` imports fold into `gui.js` as a runtime `injectStyle` (`cssModule`), the
// same as the esbuild path — no host links a separate stylesheet (see `cssModule`).
//
// `Bun.*` is a global from `@types/bun` (scoped to this file via the reference
// below); Node-side modules never import this one, so they don't see it.
/// <reference types="bun" />

import type { ResolvedImports } from './imports.ts'
import type { CompileResult, Diagnostic, ProjectInput, Range } from './toolchain.ts'
import {
	compileVfs,
	cssModule,
	loaderFor,
	RUNTIME,
	rejectComputedImports,
	resolveRelative,
	unsupportedImport,
	VFS
} from './toolchain.vfs.ts'

const REMOTE = 'devkit-remote'

// Bundle each named entry of a draft with `Bun.build`, reading bytes back from the
// in-memory `result.outputs` (no temp dir). `throw: false` so a failed pass
// returns its diagnostics rather than throwing — the shared `compileVfs` collects
// them, exactly as the esbuild adapter does.
export function bunCompile(
	input: ProjectInput,
	runtime: Record<string, string>,
	imports?: ResolvedImports
): Promise<CompileResult> {
	return compileVfs(input, runtime, async ({ entry, sources }, rt) => {
		const result = await Bun.build({
			entrypoints: [entry],
			format: 'esm',
			target: 'browser',
			throw: false,
			// Our entries are virtual (the vfs plugin resolves them), and a directory-
			// prefixed one like `src/app.ts` makes Bun derive `src` as the build root and
			// try to OPEN it on the real fs — which throws `failed to open root directory`
			// before the plugin ever runs (and before `throw: false` can swallow it). Pin
			// the root to a real, always-present dir so that probe succeeds; outputs are
			// read back by their `.js`/`.css` suffix, so the relativised path is moot.
			root: process.cwd(),
			plugins: [vfs(sources, rt, imports, input.tsconfig.compilerOptions?.jsx === 'react-jsx')]
		})
		if (!result.success) {
			return { diagnostics: result.logs.map((log) => logDiagnostic(log, 'error')) }
		}
		const js = result.outputs.find((output) => output.path.endsWith('.js'))
		return {
			js: js ? await js.text() : '',
			diagnostics: result.logs
				.filter((log) => log.level === 'warning')
				.map((log) => logDiagnostic(log, 'warning'))
		}
	})
}

function vfs(
	files: Record<string, string>,
	runtime: Record<string, string>,
	imports?: ResolvedImports,
	jsx = false
): BunPlugin {
	return {
		name: 'devkit-vfs',
		setup(build) {
			const depths = new Map<string, number>()
			const remote = async (url: string, depth: number) => {
				if (!imports) return
				if (depth > imports.limits.depth) throw new Error('Import graph is too deep')
				const file = await imports.load(url)
				const prior = depths.get(file.url)
				if (prior === undefined || depth < prior) depths.set(file.url, depth)
				return { path: file.url, namespace: REMOTE }
			}
			build.onResolve({ filter: /.*/ }, async (args) => {
				// No `kind` check needed: Bun runs plugins on entrypoints (1.2.22+) and
				// the entry path is always in `files`, so the first branch catches it.
				if (args.path in files) return { path: args.path, namespace: VFS }
				if (args.namespace === REMOTE && imports) {
					const url = imports.resolve(args.path, args.importer, 'code')
					return remote(url, (depths.get(args.importer) ?? 0) + 1)
				}
				if (args.path.startsWith('.')) {
					const resolved = resolveRelative(args.importer, args.path, files)
					return resolved ? { path: resolved, namespace: VFS } : undefined
				}
				if (args.path in runtime) return { path: args.path, namespace: RUNTIME }
				const entry = imports?.code[args.path]
				if (entry) return remote(entry, 0)
				// Nothing else is resolvable. Bun's `OnResolveResult` has no `errors` field,
				// so THROW — with `throw: false` Bun captures it into `result.logs` (an
				// error-level BuildMessage at the import site), same as esbuild's error.
				throw new Error(unsupportedImport(args.path))
			})
			build.onLoad({ filter: /.*/, namespace: VFS }, (args) => {
				// `.css` becomes a runtime-injecting JS module (folded into gui.js) rather
				// than an unlinked sidecar — no host loads a separate stylesheet.
				if (args.path.endsWith('.css'))
					return { contents: cssModule(files[args.path] ?? ''), loader: 'js' }
				return { contents: files[args.path] ?? '', loader: loaderFor(args.path, jsx) }
			})
			build.onLoad({ filter: /.*/, namespace: RUNTIME }, (args) => ({
				contents: runtime[args.path] ?? '',
				loader: 'js'
			}))
			build.onLoad({ filter: /.*/, namespace: REMOTE }, async (args) => {
				const contents = (await imports?.load(args.path))?.text ?? ''
				const loader = args.path.endsWith('.json') ? 'json' : 'js'
				if (loader === 'js') await rejectComputedImports(contents)
				return { contents, loader }
			})
		}
	}
}

const ZERO: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

// Map a Bun build/resolve log to the shared LSP-shaped `Diagnostic`. Bun's
// `position` is 1-based line / 0-based column (like esbuild's `Location`); a log
// with no position (a config/global error) collapses to the zero range.
function logDiagnostic(
	log: { message: string; position?: { line: number; column: number; file?: string } | null },
	severity: 'error' | 'warning'
): Diagnostic {
	const pos = log.position
	const start = pos ? { line: Math.max(0, pos.line - 1), character: pos.column } : ZERO.start
	return {
		file: pos?.file ?? '',
		range: { start, end: start },
		severity,
		source: 'bun',
		message: log.message
	}
}

// Local alias so the file needs no value import from `bun` — `@types/bun` provides
// the `BunPlugin` type globally under the reference above.
type BunPlugin = import('bun').BunPlugin

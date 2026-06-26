// The Bun adapter of the devkit toolchain: a `Bun.build` plugin + options over the
// same bundler-agnostic vfs rules as `toolchain.esbuild.ts`. Runs only under Bun
// (`Bun.build` is in the runtime — see the migration spike), so it's selected via
// the `#engine` runtime condition and never imported under Node. Same externalised
// React, same virtual `runtime` injection, same `app.js`/`gui.js` output shape.
// `.css` imports fold into `gui.js` as a runtime `injectStyle` (`cssModule`), the
// same as the esbuild path — no host links a separate stylesheet (see `cssModule`).
//
// `Bun.*` is a global from `@types/bun` (scoped to this file via the reference
// below); Node-side modules never import this one, so they don't see it.
/// <reference types="bun" />

import { isSdkSpec, reactExternals } from '../../runtime-specs.ts'
import type { CompileResult, Diagnostic, ProjectInput, Range } from './toolchain.ts'
import {
	compileVfs,
	cssModule,
	loaderFor,
	RUNTIME,
	resolveRelative,
	unsupportedImport,
	VFS
} from './toolchain.vfs.ts'

// Bundle each named entry of a draft with `Bun.build`, reading bytes back from the
// in-memory `result.outputs` (no temp dir). `throw: false` so a failed pass
// returns its diagnostics rather than throwing — the shared `compileVfs` collects
// them, exactly as the esbuild adapter does.
export function bunCompile(
	input: ProjectInput,
	runtime: Record<string, string>
): Promise<CompileResult> {
	return compileVfs(input, runtime, async ({ entry, sources }, rt) => {
		const result = await Bun.build({
			entrypoints: [entry],
			format: 'esm',
			target: 'browser',
			external: reactExternals,
			throw: false,
			// Our entries are virtual (the vfs plugin resolves them), and a directory-
			// prefixed one like `src/app.ts` makes Bun derive `src` as the build root and
			// try to OPEN it on the real fs — which throws `failed to open root directory`
			// before the plugin ever runs (and before `throw: false` can swallow it). Pin
			// the root to a real, always-present dir so that probe succeeds; outputs are
			// read back by their `.js`/`.css` suffix, so the relativised path is moot.
			root: process.cwd(),
			// Emit PRODUCTION automatic JSX (`jsx`/`jsxs` from `react/jsx-runtime`) like
			// the esbuild path. Bun defaults to the dev runtime (`jsxDEV` from
			// `react/jsx-dev-runtime`) when NODE_ENV isn't production — but the vendored
			// React is a production build with no `jsxDEV` export, so a dev-JSX draft mounts
			// to `jsxDEV is not a function`. NODE_ENV drives Bun's JSX runtime choice.
			define: { 'process.env.NODE_ENV': '"production"' },
			plugins: [vfs(sources, rt)]
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

function vfs(files: Record<string, string>, runtime: Record<string, string>): BunPlugin {
	return {
		name: 'devkit-vfs',
		setup(build) {
			build.onResolve({ filter: /.*/ }, (args) => {
				// No `kind` check needed: Bun runs plugins on entrypoints (1.2.22+) and
				// the entry path is always in `files`, so the first branch catches it.
				if (args.path in files) return { path: args.path, namespace: VFS }
				if (args.path.startsWith('.')) {
					const resolved = resolveRelative(args.importer, args.path, files)
					return resolved ? { path: resolved, namespace: VFS } : undefined
				}
				if (args.path in runtime) return { path: args.path, namespace: RUNTIME }
				if (isSdkSpec(args.path))
					throw new Error(`devkit runtime is missing SDK module "${args.path}"`)
				// React passes through to the top-level `external`; any other bare specifier
				// is an unsupported npm package. Bun's `OnResolveResult` has no `errors`
				// field, so THROW — with `throw: false` Bun captures it into `result.logs`
				// (an error-level BuildMessage at the import site), same as esbuild's error.
				const message = unsupportedImport(args.path)
				if (message) throw new Error(message)
				return undefined // react → external
			})
			build.onLoad({ filter: /.*/, namespace: VFS }, (args) => {
				// `.css` becomes a runtime-injecting JS module (folded into gui.js) rather
				// than an unlinked sidecar — no host loads a separate stylesheet.
				if (args.path.endsWith('.css'))
					return { contents: cssModule(files[args.path] ?? ''), loader: 'js' }
				return { contents: files[args.path] ?? '', loader: loaderFor(args.path) }
			})
			build.onLoad({ filter: /.*/, namespace: RUNTIME }, (args) => ({
				contents: runtime[args.path] ?? '',
				loader: 'js'
			}))
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

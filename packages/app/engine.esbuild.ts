// The esbuild adapter of the devkit engine: a thin esbuild plugin + build options
// over the bundler-agnostic vfs rules in `engine.vfs.ts`. `typescriptEngine`
// (Node/quay) reuses `esbuildCompile`; `esbuildEngine` is the standalone
// compile-only `Engine` the browser (frieren) and desktop hosts wrap — they get
// `compile`, and `typecheck` degrades to CAPABILITY_UNAVAILABLE at the host. The
// browser esbuild-wasm path injects its own `build`; the Bun sibling lives in
// `engine.bun.ts` behind the same vfs rules.

import type { BuildOptions, BuildResult, Loader, Message, Plugin } from 'esbuild'
import type { Compile, CompileResult, Diagnostic, Engine, ProjectInput, Range } from './engine.ts'
import { compileVfs, EXTERNAL, loaderFor, RUNTIME, resolveRelative, VFS } from './engine.vfs.ts'

export type BuildFn = (options: BuildOptions) => Promise<BuildResult>

// The injected build backend for the build/pack pipeline: a bundler-agnostic
// `Compile` closure (the host binds its bundler + the system `runtime` into it —
// native esbuild here, `esbuild-wasm` in a browser host, `Bun.build` under bun).
export type Toolchain = { compile: Compile }

// Bundle each named entry of a draft against the system `runtime`. Pure: the
// caller injects the esbuild engine + the runtime map. The shared `compileVfs`
// orchestrates the entries + the React-GUI wrap; this only supplies the esbuild
// pass (one bad entry's error stays its own diagnostics, never sinks the others).
export function esbuildCompile(
	input: ProjectInput,
	build: BuildFn,
	runtime: Record<string, string>
): Promise<CompileResult> {
	return compileVfs(input, runtime, async ({ entry, sources }, rt) => {
		try {
			const result = await build({
				entryPoints: [entry],
				bundle: true,
				write: false,
				format: 'esm',
				external: EXTERNAL,
				jsx: 'automatic',
				logLevel: 'silent',
				plugins: [vfs(sources, rt)]
			})
			return {
				js: result.outputFiles?.[0]?.text ?? '',
				diagnostics: result.warnings.map((warning) => messageDiagnostic(warning, 'warning'))
			}
		} catch (error) {
			return { diagnostics: errorDiagnostics(error) }
		}
	})
}

// Compile-only `Engine` for hosts without a type checker (browser / desktop).
// `typecheck` is never reached — those hosts answer the capability with
// CAPABILITY_UNAVAILABLE before delegating — so it throws if called directly.
export function esbuildEngine(tc: Toolchain): Engine {
	return {
		compile: tc.compile,
		typecheck: () => {
			throw new Error('typecheck is unavailable in the esbuild engine')
		}
	}
}

function vfs(files: Record<string, string>, runtime: Record<string, string>): Plugin {
	return {
		name: 'devkit-vfs',
		setup(build) {
			build.onResolve({ filter: /.*/ }, (args) => {
				if (args.kind === 'entry-point') return { path: args.path, namespace: VFS }
				if (args.path.startsWith('.')) {
					const resolved = resolveRelative(args.importer, args.path, files)
					return resolved ? { path: resolved, namespace: VFS } : undefined
				}
				// A pre-bundled system library; side-effect-free so unused exports
				// (e.g. the kernel half of `@justfiles/app`) tree-shake away.
				if (args.path in runtime) return { path: args.path, namespace: RUNTIME, sideEffects: false }
				return undefined
			})
			build.onLoad({ filter: /.*/, namespace: VFS }, (args) => ({
				contents: files[args.path] ?? '',
				loader: loaderFor(args.path) as Loader
			}))
			build.onLoad({ filter: /.*/, namespace: RUNTIME }, (args) => ({
				contents: runtime[args.path],
				loader: 'js'
			}))
		}
	}
}

const ZERO: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

// esbuild `Location` is 1-based line / 0-based byte column; LSP `Range` is
// 0-based. We map line−1 and treat the byte column as the character (close enough
// for ASCII source; the editor re-resolves on click).
function rangeOf(location: Message['location']): Range {
	if (!location) return ZERO
	const start = { line: Math.max(0, location.line - 1), character: location.column }
	return { start, end: { line: start.line, character: location.column + location.length } }
}

function messageDiagnostic(message: Message, severity: 'error' | 'warning'): Diagnostic {
	const related = message.notes
		.filter((note) => note.location)
		.map((note) => ({
			file: note.location?.file ?? '',
			range: rangeOf(note.location),
			message: note.text
		}))
	return {
		file: message.location?.file ?? '',
		range: rangeOf(message.location),
		severity,
		source: 'esbuild',
		...(message.id ? { code: message.id } : {}),
		message: message.text,
		...(related.length > 0 ? { related } : {})
	}
}

function errorDiagnostics(error: unknown): Diagnostic[] {
	const errors = (error as { errors?: Message[] }).errors
	if (Array.isArray(errors) && errors.length > 0)
		return errors.map((message) => messageDiagnostic(message, 'error'))
	return [
		{
			file: '',
			range: ZERO,
			severity: 'error',
			source: 'esbuild',
			message: error instanceof Error ? error.message : String(error)
		}
	]
}

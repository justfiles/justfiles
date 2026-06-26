// The esbuild adapter of the devkit toolchain: a thin esbuild plugin + build
// options over the bundler-agnostic vfs rules in `toolchain.vfs.ts`. The browser
// (frieren) and desktop hosts inject `esbuildCompile` as their `Toolchain.compile`
// (no `typecheck` — the devkit factory degrades it to CAPABILITY_UNAVAILABLE);
// `typescriptToolchain` (Node/quay) reuses it too. The browser esbuild-wasm path
// injects its own `build`; the Bun sibling lives in `toolchain.bun.ts` behind the
// same vfs rules.

import type { BuildOptions, BuildResult, Loader, Message, Plugin } from 'esbuild'
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

export type BuildFn = (options: BuildOptions) => Promise<BuildResult>

// Bundle each named entry of a draft against the system `runtime`. Pure: the
// caller injects the esbuild toolchain + the runtime map. The shared `compileVfs`
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
				external: reactExternals,
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
				if (isSdkSpec(args.path))
					return { errors: [{ text: `devkit runtime is missing SDK module "${args.path}"` }] }
				// React passes through to the top-level `external`; any other bare
				// specifier is an unsupported npm package — a clear error, not esbuild's
				// opaque "Could not resolve".
				const message = unsupportedImport(args.path)
				return message ? { errors: [{ text: message }] } : undefined
			})
			build.onLoad({ filter: /.*/, namespace: VFS }, (args) => {
				// `.css` becomes a runtime-injecting JS module (the css loader's sidecar
				// is dropped at outputFiles[0] and never linked by the host) — so a plain
				// `import './x.css'` folds into gui.js, same as an in-repo build.
				if (args.path.endsWith('.css'))
					return { contents: cssModule(files[args.path] ?? ''), loader: 'js' }
				return {
					contents: files[args.path] ?? '',
					loader: loaderFor(args.path) as Loader
				}
			})
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

// The esbuild half of the devkit engine: a pure `ProjectInput → CompileResult`
// bundle step, the one home for the vfs resolver + the system-runtime injection.
// `typescriptEngine` (Node/quay) and a future `nativeEngine` (container) both
// reuse `esbuildCompile`; `esbuildEngine` is the standalone compile-only `Engine`
// the browser (frieren) and desktop hosts wrap — they get `compile`, and
// `typecheck` degrades to CAPABILITY_UNAVAILABLE at the host (see the engine doc).
//
// This generalises the legacy `devkit.compile` to N named entries + structured
// `Diagnostic`s; `devkit.compile` now adapts over it for the string-diagnostic
// preview/ship path.

import type { BuildOptions, BuildResult, Loader, Message, Plugin } from 'esbuild'
import type {
	CompileResult,
	Diagnostic,
	Engine,
	OutputFile,
	ProjectInput,
	Range
} from './engine.ts'
import { isReactGuiEntry, reactGuiEntry } from './react-entry.ts'

export type BuildFn = (options: BuildOptions) => Promise<BuildResult>

// The injected toolchain: the esbuild `build` engine (native esbuild on a Node
// host; `esbuild-wasm` in a browser host) plus the pre-bundled system libraries
// keyed by import specifier (`devkit-runtime`).
export type Toolchain = { build: BuildFn; runtime: Record<string, string> }

// React stays external (resolved through the host importmap) so a preview shares
// the one host React instance. Mirrors the list `buildRuntime` keeps external.
const EXTERNAL = [
	'react',
	'react-dom',
	'react-dom/client',
	'react/jsx-runtime',
	'react/jsx-dev-runtime'
]

const VFS = 'devkit-vfs'
const RUNTIME = 'devkit-runtime'
const REACT_GUI_ENTRY = '__react_gui_entry.ts'

// Bundle each named entry of a draft against the system `runtime`. Pure: the
// caller injects the esbuild engine + the runtime map. Each entry is bundled in
// its own pass so one bad entry doesn't sink the others; a `.tsx`/`.jsx` entry is
// wrapped by the React GUI shim first. Output paths are `<entryName>.js`; the
// preview/host picks bundles by those conventional names.
export async function esbuildCompile(
	input: ProjectInput,
	build: BuildFn,
	runtime: Record<string, string>
): Promise<CompileResult> {
	const outputs: OutputFile[] = []
	const diagnostics: Diagnostic[] = []
	for (const [name, entry] of Object.entries(input.entries)) {
		if (!(entry in input.files)) {
			diagnostics.push(plain(entry, `missing entry: ${entry}`))
			continue
		}
		const wrap = isReactGuiEntry(entry)
		const sources = wrap
			? { ...input.files, [REACT_GUI_ENTRY]: reactGuiEntry(`./${entry}`) }
			: input.files
		try {
			const result = await build({
				entryPoints: [wrap ? REACT_GUI_ENTRY : entry],
				bundle: true,
				write: false,
				format: 'esm',
				external: EXTERNAL,
				jsx: 'automatic',
				logLevel: 'silent',
				plugins: [vfs(sources, runtime)]
			})
			for (const warning of result.warnings) diagnostics.push(messageDiagnostic(warning, 'warning'))
			outputs.push({ path: `${name}.js`, text: result.outputFiles?.[0]?.text ?? '' })
		} catch (error) {
			diagnostics.push(...errorDiagnostics(error))
		}
	}
	return { outputs, diagnostics }
}

// Compile-only `Engine` for hosts without a type checker (browser / desktop).
// `typecheck` is never reached — those hosts answer the capability with
// CAPABILITY_UNAVAILABLE before delegating — so it throws if called directly.
export function esbuildEngine(tc: Toolchain): Engine {
	return {
		compile: (input) => esbuildCompile(input, tc.build, tc.runtime),
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
				loader: loaderFor(args.path)
			}))
			build.onLoad({ filter: /.*/, namespace: RUNTIME }, (args) => ({
				contents: runtime[args.path],
				loader: 'js'
			}))
		}
	}
}

function resolveRelative(
	importer: string,
	spec: string,
	files: Record<string, string>
): string | undefined {
	const baseDir = importer.includes('/') ? importer.slice(0, importer.lastIndexOf('/')) : ''
	const parts = baseDir ? baseDir.split('/') : []
	for (const seg of spec.split('/')) {
		if (seg === '' || seg === '.') continue
		if (seg === '..') parts.pop()
		else parts.push(seg)
	}
	const joined = parts.join('/')
	const candidates = [joined, `${joined}.ts`, `${joined}.tsx`, `${joined}.js`, `${joined}/index.ts`]
	return candidates.find((candidate) => candidate in files)
}

function loaderFor(path: string): Loader {
	if (path.endsWith('.tsx')) return 'tsx'
	if (path.endsWith('.jsx')) return 'jsx'
	if (path.endsWith('.js')) return 'js'
	if (path.endsWith('.json')) return 'json'
	return 'ts'
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
	return [plain('', error instanceof Error ? error.message : String(error))]
}

function plain(file: string, message: string): Diagnostic {
	return { file, range: ZERO, severity: 'error', source: 'esbuild', message }
}

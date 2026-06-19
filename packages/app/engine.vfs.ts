// The bundler-agnostic half of the devkit compile engine: the `files`-map
// resolve/load rules, the externalised-React list, the React-GUI entry wrap, and
// the per-entry orchestration that shapes a `ProjectInput` into a `CompileResult`.
// No esbuild/Bun types live here — `engine.esbuild.ts` and `engine.bun.ts` are
// thin adapters that plug their bundler's `onResolve`/`onLoad` into these rules and
// hand `compileVfs` a single `buildOne` strategy. One home for the substance; the
// per-bundler glue stays tens of lines each.

import type { CompileResult, Diagnostic, OutputFile, ProjectInput, Range } from './engine.ts'
import { isReactGuiEntry, reactGuiEntry } from './react-entry.ts'

// React stays external (resolved through the host importmap) so a preview shares
// the one host React instance. Mirrors the list `buildRuntime` keeps external.
export const EXTERNAL = [
	'react',
	'react-dom',
	'react-dom/client',
	'react/jsx-runtime',
	'react/jsx-dev-runtime'
]

// The two virtual namespaces a bundler plugin tags resolved paths with: draft
// sources from the `files` map, and pre-bundled system libraries from `runtime`.
export const VFS = 'devkit-vfs'
export const RUNTIME = 'devkit-runtime'
// The synthetic entry the React-GUI wrap injects (see `reactGuiEntry`).
export const REACT_GUI_ENTRY = '__react_gui_entry.ts'

// The common loader vocabulary — every value is accepted verbatim by both esbuild
// and Bun's `loader` field, so each adapter casts to its own `Loader` type.
export type VfsLoader = 'ts' | 'tsx' | 'jsx' | 'js' | 'json' | 'css'

export function loaderFor(path: string): VfsLoader {
	if (path.endsWith('.tsx')) return 'tsx'
	if (path.endsWith('.jsx')) return 'jsx'
	if (path.endsWith('.js')) return 'js'
	if (path.endsWith('.json')) return 'json'
	if (path.endsWith('.css')) return 'css'
	return 'ts'
}

// Resolve a relative import against the `files` map (the both-bundlers vfs rule):
// join `spec` onto the importer's dir, then probe the conventional extensions.
export function resolveRelative(
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

export const ZERO: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

export function plain(file: string, message: string): Diagnostic {
	return { file, range: ZERO, severity: 'error', source: 'esbuild', message }
}

// What a single entry's bundle produced: its JS (omitted on a hard build error,
// so the entry contributes no output), an optional CSS sidecar (Bun bundles
// `import './x.css'`; the esbuild path doesn't), and this entry's diagnostics.
export interface VfsBuildResult {
	js?: string
	css?: string
	diagnostics: Diagnostic[]
}

// What the orchestrator hands a `buildOne` strategy: the output name, the actual
// entry path to bundle (the React-GUI shim when the author's entry is `.tsx`/
// `.jsx`), and the source map to resolve/load against (with the shim injected).
export interface VfsBuildArgs {
	name: string
	entry: string
	sources: Record<string, string>
}

// Bundle each named entry of a draft against the system `runtime`, applying the
// React-GUI wrap and collecting outputs + diagnostics. The caller's `buildOne`
// runs one bundler pass and never throws — it returns its diagnostics. Output
// paths are `<entryName>.js` (+ `.css` when present); the host picks bundles by
// those conventional names.
export async function compileVfs(
	input: ProjectInput,
	runtime: Record<string, string>,
	buildOne: (args: VfsBuildArgs, runtime: Record<string, string>) => Promise<VfsBuildResult>
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
		const result = await buildOne({ name, entry: wrap ? REACT_GUI_ENTRY : entry, sources }, runtime)
		diagnostics.push(...result.diagnostics)
		if (result.js !== undefined) outputs.push({ path: `${name}.js`, text: result.js })
		if (result.css !== undefined) outputs.push({ path: `${name}.css`, text: result.css })
	}
	return { outputs, diagnostics }
}

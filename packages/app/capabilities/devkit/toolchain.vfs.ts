// The bundler-agnostic half of the devkit compile toolchain: the `files`-map
// resolve/load rules, SDK runtime bundling, and the per-entry orchestration that
// shapes a `ProjectInput` into a `CompileResult`.
// No esbuild/Bun types live here — `toolchain.esbuild.ts` and `toolchain.bun.ts` are
// thin adapters that plug their bundler's `onResolve`/`onLoad` into these rules and
// hand `compileVfs` a single `buildOne` strategy. One home for the substance; the
// per-bundler glue stays tens of lines each.

import type { CompileResult, Diagnostic, OutputFile, ProjectInput, Range } from './toolchain.ts'

// Devkit bundles every bare specifier it supports into the emitted entry from the
// pre-built `runtime` source (the `RUNTIME` namespace), matching the Vite app artifact
// shape. That is the platform SDK and valibot — a draft gets no UI framework, so its
// GUI is plain DOM through `defineGUI`. There is no top-level `external` in either
// adapter.

// The two virtual namespaces a bundler plugin tags resolved paths with: draft
// sources from the `files` map, and pre-bundled system libraries from `runtime`.
export const VFS = 'devkit-vfs'
export const RUNTIME = 'devkit-runtime'

// The common loader vocabulary — every value is accepted verbatim by both esbuild
// and Bun's `loader` field, so each adapter casts to its own `Loader` type.
export type VfsLoader = 'ts' | 'js' | 'json' | 'css'

export function loaderFor(path: string): VfsLoader {
	if (path.endsWith('.js')) return 'js'
	if (path.endsWith('.json')) return 'json'
	if (path.endsWith('.css')) return 'css'
	return 'ts'
}

// Compile a `.css` import into a JS side-effect module that injects the CSS at
// runtime. The host loads only `gui.js`, so a real CSS file (esbuild would drop
// it; Bun would emit an unlinked sidecar) never applies — folding it into the JS
// via the SDK's `injectStyle` is exactly what an author would hand-write, and the
// same end state the kernelHost build reaches for in-repo packages (vite.ts).
// `injectStyle` dedups on the CSS text, so a re-mount won't stack <style> tags.
export function cssModule(css: string): string {
	return `import { injectStyle } from '@justfiles/app/browser'\ninjectStyle(${JSON.stringify(css)})\n`
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
	const candidates = [joined, `${joined}.ts`, `${joined}.js`, `${joined}/index.ts`]
	return candidates.find((candidate) => candidate in files)
}

// Why devkit can't resolve this BARE specifier — both compile paths call this in their
// `onResolve` terminal branch, after the `runtime` map has had its chance. The map is
// complete by the time a compile runs (`loadRuntime` checks it against the SDK's own
// list), so anything left here is an npm package app-code deliberately doesn't support:
// it's a built-in authoring tool, not an npm dev environment — authors who need arbitrary
// packages use create-app. A clear message in BOTH compile paths (and the browser
// esbuild-wasm fallback) beats the bundler's opaque "Could not resolve".
export function unsupportedImport(spec: string): string {
	return `External npm package "${spec}" is not supported in app-code. Use packages/create-app for a full package project.`
}

export const ZERO: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

export function plain(file: string, message: string): Diagnostic {
	return { file, range: ZERO, severity: 'error', source: 'esbuild', message }
}

// What a single entry's bundle produced: its JS (omitted on a hard build error, so
// the entry contributes no output) and this entry's diagnostics. CSS never appears
// here — `.css` imports fold into the JS as `injectStyle` calls (`cssModule`), since
// no host links a separate stylesheet.
export interface VfsBuildResult {
	js?: string
	diagnostics: Diagnostic[]
}

// What the orchestrator hands a `buildOne` strategy: the entry path to bundle and
// the source map to resolve/load against.
export interface VfsBuildArgs {
	entry: string
	sources: Record<string, string>
}

// Bundle each named entry of a draft against the system `runtime`, collecting
// outputs + diagnostics. The caller's `buildOne`
// runs one bundler pass and never throws — it returns its diagnostics. Output
// paths are `<entryName>.js`; the host picks bundles by those conventional names.
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
		// Every entry bundles the SDK from the host-supplied runtime map. Nothing is
		// left external.
		const result = await buildOne({ entry, sources: input.files }, runtime)
		diagnostics.push(...result.diagnostics)
		if (result.js !== undefined) outputs.push({ path: `${name}.js`, text: result.js })
	}
	return { outputs, diagnostics }
}

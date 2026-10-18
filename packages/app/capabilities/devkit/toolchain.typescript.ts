// The TypeScript toolchain: the TypeScript compiler API for `typecheck`, paired with
// an injected `compile` — the minimal in-process path, no subprocess. Portable JS: it
// runs in a browser worker, the Mac daemon's worker, and the dev server. `ts` is injected
// (`typeof import('typescript')`) so this module keeps only a type-only TS
// import and never pulls the 8 MB compiler into a host that doesn't want it.
//
// typecheck builds a `ts.Program` over an in-memory `CompilerHost` that overlays
// the draft's `ProjectInput.files` (and any `TypesBundle`) on the real host fs:
// a host with `node_modules` resolves `@justfiles/app` / `valibot` against the same
// source the runtime is bundled from. A host without one passes a baked `TypesBundle`
// instead; same code, no fs reliance.

import type * as TS from 'typescript'
import { importDiagnostic, type ResolvedImports } from './imports.ts'
import type {
	CheckResult,
	Compile,
	Diagnostic,
	ProjectInput,
	Range,
	TypePaths,
	TypesBundle
} from './toolchain.ts'

// The in-process toolchain: an injected `compile` backend (native
// esbuild under node, `Bun.build` under bun — selected by the host) paired with
// the TypeScript compiler API for `typecheck`. The bundler is no longer named
// here, so the same toolchain serves both runtimes; only `compile` swaps. Returns
// a `Toolchain` with `typecheck` present (the optional method is supplied).
export function typescriptToolchain(opts: {
	compile: Compile // bundler-agnostic compile backend (runtime closed in)
	ts: typeof import('typescript') // typecheck
	types?: TypesBundle // .d.ts stdlib overlay (tsc); without it, node_modules
	paths?: TypePaths // tsc import-map for the SDK specifiers (from the sysroot)
}) {
	return {
		compile: opts.compile,
		typecheck: async (input: ProjectInput) =>
			tsTypecheck(input, opts.ts, opts.types ?? {}, opts.paths ?? {})
	}
}

// Let TypeScript identify declaration references. The returned files keep the
// CDN path under one virtual directory, so normal relative type imports still
// resolve through the existing compiler host.
export async function loadImportTypes(
	imports: ResolvedImports,
	ts: typeof TS
): Promise<{ types: TypesBundle; paths: TypePaths }> {
	const types: TypesBundle = {}
	const paths: TypePaths = {}
	const queue = Object.entries(imports.declarations).map(([alias, url]) => ({
		alias,
		url,
		depth: 0
	}))
	for (let index = 0; index < queue.length; index++) {
		const item = queue[index]
		if (!item) break
		if (item.depth > imports.limits.depth) throw new Error('Import graph is too deep')
		const file = await imports.load(item.url)
		const path = typePath(file.url)
		paths[item.url] = [path]
		paths[file.url] = [path]
		if (item.alias) paths[item.alias] = [path]
		if (path in types) continue
		types[path] = file.text
		const info = ts.preProcessFile(file.text, true, true)
		const references = [
			...info.importedFiles,
			...info.referencedFiles,
			...info.typeReferenceDirectives
		]
		for (const reference of references) {
			queue.push({
				alias: reference.fileName.startsWith('/') ? reference.fileName : '',
				url: imports.resolve(reference.fileName, file.url, 'types'),
				depth: item.depth + 1
			})
		}
	}
	return { types, paths }
}

// Add URL package declarations to the platform declaration set for one check.
export async function tsTypecheckImports(
	input: ProjectInput,
	ts: typeof TS,
	types: TypesBundle,
	paths: TypePaths,
	imports?: ResolvedImports
): Promise<CheckResult> {
	if (!imports) return tsTypecheck(input, ts, types, paths)
	try {
		const loaded = await loadImportTypes(imports, ts)
		return tsTypecheck(input, ts, { ...types, ...loaded.types }, { ...paths, ...loaded.paths })
	} catch (error) {
		return { diagnostics: [importDiagnostic(error)] }
	}
}

function typePath(value: string): string {
	const url = new URL(value)
	let path = url.pathname.slice(1)
	if (url.search) {
		const dot = path.lastIndexOf('.')
		const suffix = `--${encodeURIComponent(url.search.slice(1))}`
		path = dot < 0 ? `${path}${suffix}` : `${path.slice(0, dot)}${suffix}${path.slice(dot)}`
	}
	return `__imports__/${url.hostname}/${path}`
}

// The typecheck backend hosts inject into `devkitCapability` (which loads `types`
// + `paths` from the calling app's sysroot and threads them in). Building a
// `ts.Program` over an in-memory `CompilerHost`; `ts` is the injected compiler so
// no host bundles the 8 MB checker unless it opts in.
export function tsTypecheck(
	input: ProjectInput,
	ts: typeof TS,
	types: TypesBundle,
	paths: TypePaths
): CheckResult {
	// The browser TypeScript build has no `ts.sys`; it reads only the overlay.
	const system = ts.sys as TS.System | undefined
	const moduleDir = (import.meta as ImportMeta & { dirname?: string }).dirname
	const root = system
		? `${moduleDir ?? system.getCurrentDirectory()}/__engine_draft__`
		: '/__engine_draft__'
	const norm = (path: string) => `${root}/${path}`
	// Triple-slash root paths bypass compilerOptions.paths, so the host maps them too.
	const aliases = new Map<string, string>()
	for (const [specifier, [target]] of Object.entries(paths)) {
		if (specifier.startsWith('/') && target) aliases.set(specifier, norm(target))
	}
	const actual = (path: string) => aliases.get(path) ?? path
	const overlay = new Map<string, string>()
	for (const [path, text] of Object.entries(types)) overlay.set(norm(path), text)
	for (const [path, text] of Object.entries(input.files)) overlay.set(norm(path), text)
	const draftFiles = new Set(Object.keys(input.files).map(norm))
	// The virtual directories holding overlay files (every ancestor up to `root`).
	// bundler/node resolution probes `directoryExists` BEFORE `fileExists`, so
	// without these the draft's own dirs (`src/`, which never touch the real fs)
	// look empty and a relative import like `./app` resolves to nothing.
	const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'))
	const dirs = new Set<string>()
	for (const file of overlay.keys()) {
		for (let dir = dirOf(file); dir.length >= root.length && dir.startsWith(root); dir = dirOf(dir))
			dirs.add(dir)
	}

	const options: TS.CompilerOptions = {
		...ts.convertCompilerOptionsFromJson(input.tsconfig.compilerOptions ?? {}, root).options,
		noEmit: true,
		skipLibCheck: true,
		// The SDK import-map: tsc resolves `@justfiles/app/*` through these paths (vendored
		// externals still resolve via their own package.json). The sysroot stores them
		// overlay-root-relative; we absolutize against `root` so no `baseUrl` is needed
		// (it's deprecated in TS 6 / removed in TS 7).
		paths: Object.fromEntries(
			Object.entries(paths).map(([spec, targets]) => [spec, targets.map((t) => `${root}/${t}`)])
		)
	}
	const fileExists = (file: string) =>
		overlay.has(actual(file)) || (system?.fileExists(actual(file)) ?? false)
	const readFile = (file: string) => overlay.get(actual(file)) ?? system?.readFile(actual(file))
	const directoryExists = (dir: string) => {
		const d = dir.endsWith('/') ? dir.slice(0, -1) : dir
		return dirs.has(d) || (system?.directoryExists?.(dir) ?? false)
	}
	const host: TS.CompilerHost = {
		fileExists,
		readFile,
		directoryExists,
		getCanonicalFileName: (file) =>
			system && !system.useCaseSensitiveFileNames ? file.toLowerCase() : file,
		getCurrentDirectory: () => root,
		getDefaultLibFileName: (compilerOptions) =>
			system
				? ts.getDefaultLibFilePath(compilerOptions)
				: norm(ts.getDefaultLibFileName(compilerOptions)),
		getDirectories: (dir) => system?.getDirectories(dir) ?? [],
		getNewLine: () => system?.newLine ?? '\n',
		getSourceFile: (file, languageVersion, onError) => {
			const path = actual(file)
			const text = readFile(path)
			if (text === undefined) {
				onError?.(`File not found: ${file}`)
				return
			}
			return ts.createSourceFile(path, text, languageVersion, true)
		},
		useCaseSensitiveFileNames: () => system?.useCaseSensitiveFileNames ?? true,
		writeFile: () => {}
	}
	const realpath = system?.realpath
	if (realpath) host.realpath = realpath

	const rootNames = Object.values(input.entries)
		.filter((entry) => entry in input.files)
		.map(norm)
	const program = ts.createProgram({ rootNames, options, host })
	// Only surface diagnostics for the draft's own files (and global/config ones);
	// skipLibCheck already silences the stdlib, this drops any straggler.
	const diagnostics = [
		...program.getOptionsDiagnostics(),
		...program.getGlobalDiagnostics(),
		...program.getSyntacticDiagnostics(),
		...program.getSemanticDiagnostics()
	]
		.filter((diagnostic) => !diagnostic.file || draftFiles.has(diagnostic.file.fileName))
		.map((diagnostic) => toDiagnostic(diagnostic, ts, root))
	return { diagnostics }
}

const ZERO: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

function toDiagnostic(diagnostic: TS.Diagnostic, ts: typeof TS, root: string): Diagnostic {
	const { file } = diagnostic
	const range =
		file && diagnostic.start !== undefined
			? {
					start: posOf(file, diagnostic.start),
					end: posOf(file, diagnostic.start + (diagnostic.length ?? 0))
				}
			: ZERO
	const related = diagnostic.relatedInformation
		?.filter((info) => info.file && info.start !== undefined)
		.map((info) => ({
			file: rel(info.file?.fileName ?? '', root),
			range:
				info.file && info.start !== undefined
					? {
							start: posOf(info.file, info.start),
							end: posOf(info.file, info.start + (info.length ?? 0))
						}
					: ZERO,
			message: ts.flattenDiagnosticMessageText(info.messageText, '\n')
		}))
	return {
		file: file ? rel(file.fileName, root) : '',
		range,
		severity: severityOf(diagnostic.category, ts),
		source: 'ts',
		code: `TS${diagnostic.code}`,
		message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
		...(related && related.length > 0 ? { related } : {})
	}
}

function posOf(file: TS.SourceFile, position: number): { line: number; character: number } {
	const { line, character } = file.getLineAndCharacterOfPosition(position)
	return { line, character }
}

function severityOf(category: TS.DiagnosticCategory, ts: typeof TS): Diagnostic['severity'] {
	if (category === ts.DiagnosticCategory.Error) return 'error'
	if (category === ts.DiagnosticCategory.Warning) return 'warning'
	return 'info'
}

function rel(fileName: string, root: string): string {
	return fileName.startsWith(`${root}/`) ? fileName.slice(root.length + 1) : fileName
}

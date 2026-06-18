// The Node (quay) engine: esbuild for `compile`, the TypeScript compiler API for
// `typecheck` — the minimal in-process path, no subprocess. Portable JS: it runs
// in quayd today and, unchanged, in a Worker if ever needed. `ts` is injected
// (`typeof import('typescript')`) so this module keeps only a type-only TS
// import and never pulls the 8 MB compiler into a host that doesn't want it.
//
// typecheck builds a `ts.Program` over an in-memory `CompilerHost` that overlays
// the draft's `ProjectInput.files` (and any `TypesBundle`) on the real host fs:
// quay has `node_modules`, so `@justfiles/app` / `valibot` / `react` resolve
// against the same source the runtime is bundled from. The container (Phase 4)
// passes a baked `TypesBundle` instead; same code, no fs reliance.

import type * as TS from 'typescript'
import { type BuildFn, esbuildCompile } from './engine.esbuild.ts'
import type { CheckResult, Diagnostic, Engine, ProjectInput, Range, TypesBundle } from './engine.ts'

export function typescriptEngine(opts: {
	build: BuildFn // esbuild engine (compile)
	ts: typeof import('typescript') // typecheck
	runtime: Record<string, string> // JS stdlib (esbuild)
	types?: TypesBundle // .d.ts stdlib overlay (tsc); quay falls back to node_modules
}): Engine {
	return {
		compile: (input) => esbuildCompile(input, opts.build, opts.runtime),
		typecheck: async (input) => typecheck(input, opts.ts, opts.types ?? {})
	}
}

function typecheck(input: ProjectInput, ts: typeof TS, types: TypesBundle): CheckResult {
	// Root the virtual draft inside this package's own dir, so node resolution
	// reaches `@justfiles/app` (self-reference) + its deps (`valibot`, `react`,
	// `@types/react`) regardless of the host's cwd. The container (Phase 4) passes
	// a complete `TypesBundle` instead and never touches the fs.
	const root = `${import.meta.dirname}/__engine_draft__`
	const norm = (path: string) => `${root}/${path}`
	// In-memory overlay: draft sources + the stdlib `.d.ts` bundle. Anything else
	// (lib.*.d.ts, node_modules) falls through to the real host below.
	const overlay = new Map<string, string>()
	for (const [path, text] of Object.entries(types)) overlay.set(norm(path), text)
	for (const [path, text] of Object.entries(input.files)) overlay.set(norm(path), text)
	const draftFiles = new Set(Object.keys(input.files).map(norm))

	const options: TS.CompilerOptions = {
		...ts.convertCompilerOptionsFromJson(input.tsconfig.compilerOptions ?? {}, root).options,
		noEmit: true,
		skipLibCheck: true
	}
	const host = ts.createCompilerHost(options, true)
	const baseRead = host.readFile.bind(host)
	const baseExists = host.fileExists.bind(host)
	const baseGetSource = host.getSourceFile.bind(host)
	host.fileExists = (file) => overlay.has(file) || baseExists(file)
	host.readFile = (file) => overlay.get(file) ?? baseRead(file)
	host.getSourceFile = (file, languageVersion, onError, shouldCreate) => {
		const text = overlay.get(file)
		return text !== undefined
			? ts.createSourceFile(file, text, languageVersion, true)
			: baseGetSource(file, languageVersion, onError, shouldCreate)
	}

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

import type { BuildOptions, BuildResult, Loader, Message, Plugin } from 'esbuild'

// The Frieren build chain, run in the browser. esbuild bundles a draft's
// `app.ts` (headless reducer) and `gui.ts` (browser UI) the same way
// `kernelHost` does at ship time — React kept external (resolved through the
// page importmap) so the preview shares the one host React instance.
//
// `compile` is pure: the caller injects the esbuild engine (`esbuild-wasm`'s
// `build` in the browser; Node `esbuild` in tests) and the `runtime` map of
// pre-bundled system libraries (`@justfiles/app`, …). The vfs resolver serves
// the draft's own files plus those system libs; any other bare import is left
// unresolved on purpose — drafts compile hermetically against the provided
// stdlib only.

type BuildFn = (options: BuildOptions) => Promise<BuildResult>

export interface CompileResult {
	app: string
	gui: string
	diagnostics: string[]
}

const VFS = 'devkit-vfs'
const RUNTIME = 'devkit-runtime'
const EXTERNAL = [
	'react',
	'react-dom',
	'react-dom/client',
	'react/jsx-runtime',
	'react/jsx-dev-runtime'
]

export async function compile(
	files: Record<string, string>,
	build: BuildFn,
	runtime: Record<string, string>
): Promise<CompileResult> {
	const diagnostics: string[] = []
	const one = async (entry: string): Promise<string> => {
		try {
			const result = await build({
				entryPoints: [entry],
				bundle: true,
				write: false,
				format: 'esm',
				external: EXTERNAL,
				jsx: 'automatic',
				logLevel: 'silent',
				plugins: [vfs(files, runtime)]
			})
			return result.outputFiles?.[0]?.text ?? ''
		} catch (error) {
			diagnostics.push(...messagesOf(error))
			return ''
		}
	}
	const entry = (name: string) => [`${name}.ts`, `${name}.tsx`].find((path) => path in files)
	const appEntry = entry('app')
	const guiEntry = entry('gui')
	if (!appEntry) diagnostics.push('missing entry: app.ts')
	const app = appEntry ? await one(appEntry) : ''
	const gui = guiEntry ? await one(guiEntry) : ''
	return { app, gui, diagnostics }
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

function messagesOf(error: unknown): string[] {
	const errors = (error as { errors?: Message[] }).errors
	if (Array.isArray(errors) && errors.length > 0) {
		return errors.map((message) => {
			const loc = message.location ? ` (${message.location.file}:${message.location.line})` : ''
			return `${message.text}${loc}`
		})
	}
	return [error instanceof Error ? error.message : String(error)]
}

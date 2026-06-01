import { createRequire } from 'node:module'
import { build } from 'esbuild'

// The system libraries the devkit compiler injects into every draft bundle —
// the "stdlib shipped with the OS." Each is pre-bundled once (here, with Node
// esbuild at frieren build/serve time) into a self-contained ESM module, then
// handed to the browser `esbuild-wasm` compiler as a virtual module so drafts
// compile hermetically with no node_modules in the browser. React is NOT here:
// it stays external and resolves through the page importmap so the preview
// shares the one host React instance.
const LIBS = ['@justfiles/app', '@justfiles/app/browser', 'valibot']

export async function buildRuntime(): Promise<Record<string, string>> {
	const require = createRequire(import.meta.url)
	const runtime: Record<string, string> = {}
	for (const spec of LIBS) {
		const result = await build({
			entryPoints: [require.resolve(spec)],
			bundle: true,
			write: false,
			format: 'esm',
			platform: 'browser'
		})
		runtime[spec] = result.outputFiles[0].text
	}
	return runtime
}

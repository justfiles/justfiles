import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { build } from 'esbuild'

// The system libraries the devkit compiler injects into every draft bundle — the
// "stdlib shipped with the OS." Each is pre-bundled once (here, with Node esbuild
// — at frieren build/serve time, or in the desktop main process) into a
// self-contained ESM module, then handed to the `compile` engine as a virtual
// runtime so drafts compile hermetically with no node_modules. React is NOT here:
// it stays external and resolves through the host importmap so the preview shares
// the one host React instance.
//
// This is the one Node-only piece of the devkit pipeline (it imports the native
// esbuild engine), kept in its own subpath so the browser-safe `@justfiles/app/
// devkit` (engine-injected) never pulls native esbuild into a browser host.
const EXTERNAL = [
	'react',
	'react-dom',
	'react-dom/client',
	'react/jsx-runtime',
	'react/jsx-dev-runtime'
]

const LIBS = ['@justfiles/app', '@justfiles/app/browser', '@justfiles/app/react', 'valibot']

export async function buildRuntime(): Promise<Record<string, string>> {
	const require = createRequire(import.meta.url)
	const runtime: Record<string, string> = {}
	for (const spec of LIBS) {
		// Re-export the package from a synthetic entry rather than bundling its
		// resolved file directly. A CommonJS package (e.g. valibot) used as the
		// entry collapses to a lone `export default`, so a draft's
		// `import * as v from 'valibot'` sees no named exports and `v.object`
		// compiles to `(void 0)`. Importing it here lets esbuild apply ESM
		// conditions + CJS named-export detection, preserving `object`,
		// `string`, … as real named exports.
		const result = await build({
			stdin: {
				contents: `export * from ${JSON.stringify(spec)}`,
				resolveDir: dirname(require.resolve(spec)),
				loader: 'js'
			},
			bundle: true,
			write: false,
			format: 'esm',
			platform: 'browser',
			external: EXTERNAL
		})
		runtime[spec] = result.outputFiles[0].text
	}
	return runtime
}

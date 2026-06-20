// The node side of `#assets`: ship-time launcher bundles via native esbuild. The
// bun sibling (assetsBundler.bun.ts) expresses the same `bundleAsset` contract with
// Bun.build; selected by the runtime condition. This is the `default` resolution too,
// so tsc and the browser/node toolchains keep seeing the esbuild shape.

import { build } from 'esbuild'
import type { AssetBundle } from './assetsBundler.shared.ts'

export async function bundleAsset(opts: AssetBundle): Promise<string> {
	const result = await build({
		...(opts.contents
			? { stdin: { contents: opts.contents, resolveDir: opts.resolveDir, loader: 'js' } }
			: { entryPoints: [opts.entry as string] }),
		bundle: true,
		write: false,
		format: 'esm',
		...(opts.jsx ? { jsx: 'automatic' } : {}),
		minify: true,
		external: opts.external,
		// Production React: a quay app is an installed, shipping app, so the prod build
		// is markedly smaller and parses/renders faster in the cold WebContent process.
		define: { 'process.env.NODE_ENV': '"production"' },
		logLevel: 'silent'
	})
	const text = result.outputFiles?.[0]?.text
	if (!text) throw new Error('quayd: asset bundle produced no output')
	return text
}

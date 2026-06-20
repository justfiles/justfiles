// The bun side of `#assets`: ship-time launcher bundles via Bun.build — no esbuild, so
// a bun ship path carries zero esbuild dependency. Same `bundleAsset` contract as the
// node sibling (assetsBundler.node.ts); selected by the `bun` import condition, never
// resolved under node. Inline `contents` are fed through a virtual entrypoint (Bun's
// bundler has no stdin); `entry` builds a file directly. React stays external.

import type { AssetBundle } from './assetsBundler.shared.ts'

type BunPlugin = import('bun').BunPlugin

const VIRTUAL = 'quay-asset-entry'

// Serve inline `contents` as the entrypoint, resolving its bare imports (react,
// capnweb) from the ship-time resolveDir — the esbuild `stdin.resolveDir` analogue.
function virtualEntry(contents: string, resolveDir: string): BunPlugin {
	return {
		name: 'virtual-entry',
		setup(build) {
			build.onResolve({ filter: new RegExp(`^${VIRTUAL}$`) }, () => ({
				path: VIRTUAL,
				namespace: 'virtual-entry'
			}))
			build.onLoad({ filter: /.*/, namespace: 'virtual-entry' }, () => ({
				contents,
				loader: 'js',
				resolveDir
			}))
		}
	}
}

export async function bundleAsset(opts: AssetBundle): Promise<string> {
	const result = await Bun.build({
		entrypoints: [opts.contents ? VIRTUAL : (opts.entry as string)],
		target: 'browser',
		format: 'esm',
		minify: true,
		external: opts.external,
		define: { 'process.env.NODE_ENV': '"production"' },
		plugins: opts.contents ? [virtualEntry(opts.contents, opts.resolveDir)] : [],
		throw: false
	})
	if (!result.success) {
		for (const log of result.logs) console.error(log)
		throw new Error('quayd: asset bundle produced no output')
	}
	const out = result.outputs[0]
	if (!out) throw new Error('quayd: asset bundle empty')
	return out.text()
}

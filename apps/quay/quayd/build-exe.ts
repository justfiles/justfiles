// Production build (bun side): compile quayd into ONE self-contained Bun executable
// that embeds Bun + the bundled daemon graph. Because `Bun.build` lives in the runtime,
// install-time devkit compile runs in-process inside this exe with no external toolchain
// (Spike B #5). This is the bun half of the reversible production path
// (`build.sh --runtime bun`); the node half esbuild-bundles quayd + ships a node binary.
//
// Run from apps/quay:
//   bun quayd/build-exe.ts [--outfile <path>] [--target bun-darwin-arm64|bun-darwin-x64]
// `--target` cross-compiles per arch; omit it to build for the host.
//
// We go through the `Bun.build` JS API (not the `bun build --compile` CLI) for one
// reason: the daemon imports the agent's prompts as `*.md?raw`, and while Bun's RUNTIME
// applies a `?raw` loader natively, its BUNDLER does not — so we register that loader as
// a plugin here. The node path never bundles the daemon (it runs from source via
// rawLoader.mjs + tsx), so this plugin is bun-only.

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

type BunPlugin = import('bun').BunPlugin

// `import x from './y.md?raw'` → the file's text as the default export.
const rawText: BunPlugin = {
	name: 'raw-text',
	setup(build) {
		build.onResolve({ filter: /\?raw$/ }, (args) => ({
			path: resolve(dirname(args.importer), args.path.replace(/\?raw$/, '')),
			namespace: 'raw-text'
		}))
		build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => ({
			contents: await readFile(args.path, 'utf8'),
			loader: 'text'
		}))
	}
}

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(name)
	return i >= 0 ? process.argv[i + 1] : undefined
}

const outfile = flag('--outfile') ?? './dist/quayd'
const target = flag('--target') // bun-darwin-arm64 / bun-darwin-x64; undefined = host

const result = await Bun.build({
	entrypoints: ['./quayd/main.ts'],
	target: 'bun',
	plugins: [rawText],
	// Tell the standalone it is shipped, so resources.ts resolves assets/docs/design/
	// booter from Quay.app/Contents/Resources next to the exe — not the bunfs root.
	define: { 'process.env.QUAY_SHIPPED': '"1"' },
	compile: (target ? { outfile, target } : { outfile }) as { outfile: string }
})

if (!result.success) {
	for (const log of result.logs) console.error(log)
	process.exit(1)
}
console.log(`quayd: compiled standalone exe → ${outfile}${target ? ` (${target})` : ''}`)

// Production build: compile the daemon into ONE self-contained Bun executable. The exe
// embeds Bun + the bundled daemon graph (server/kernel/capabilities/agent). The browser
// surfaces are NOT embedded — Vite builds them into ui/dist/client and they ship beside the
// exe under Quay.app/Contents/Resources/client (native/build.sh copies them; see Step 2 of
// the migration), read from disk at request time. QUAY_SHIPPED tells the runtime to resolve
// resources next to the exe rather than the bunfs root (see ../quayd/resources.ts and
// daemon/main.ts CLIENT_DIR).
//
// Run from apps/quay:
//   bun daemon/build-exe.ts [--outfile <path>] [--target bun-darwin-arm64|bun-darwin-x64]
// `--target` cross-compiles per arch; omit it to build for the host.
//
// One bundler plugin, needed only at build time:
//   • raw-text — `import x from './y.md?raw'`: the agent imports its prompts as ?raw,
//                and Bun's BUNDLER (unlike its runtime) has no native ?raw loader.

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

const outfile = flag('--outfile') ?? './dist/quay-daemon'
const target = flag('--target') // bun-darwin-arm64 / bun-darwin-x64; undefined = host

const result = await Bun.build({
	// The daemon is the main entry; the toolchain worker is a SECOND entrypoint so its
	// graph (bunCompile + tsc) is embedded in the standalone too. Bun's static
	// `new Worker(new URL(...))` tracing doesn't reach a worker spawned indirectly
	// (via the lazy `toolchain()` handle), so we list it explicitly — otherwise the
	// worker script is missing at runtime in the shipped exe and devkit typecheck/
	// compile break (dev via `bun --watch` is unaffected). Both land at the bunfs
	// root, so `new URL('./toolchainWorker.ts', import.meta.url)` resolves as siblings.
	entrypoints: ['./daemon/main.ts', './daemon/toolchainWorker.ts'],
	target: 'bun',
	plugins: [rawText],
	// Tell the standalone it is shipped, so resources resolve from
	// Quay.app/Contents/Resources next to the exe — not the bunfs root.
	define: { 'process.env.QUAY_SHIPPED': '"1"' },
	compile: (target ? { outfile, target } : { outfile }) as { outfile: string }
})

if (!result.success) {
	for (const log of result.logs) console.error(log)
	process.exit(1)
}
console.log(`quay-daemon: compiled standalone exe → ${outfile}${target ? ` (${target})` : ''}`)

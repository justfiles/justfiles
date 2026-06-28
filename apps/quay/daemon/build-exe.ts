// Production build: compile the daemon into ONE self-contained Bun executable. The exe
// embeds Bun + the bundled daemon graph (server/kernel/capabilities/agent) AND the bundled
// HTML surfaces (launcher, chat, app shell, with their CSS + the injected vendor import
// map). The `/vendor/*` React bundles are NOT embedded — they ship beside the exe under
// Quay.app/Contents/Resources/vendor (native/build.sh copies them) and are read from disk
// at request time; QUAY_SHIPPED tells the runtime to resolve resources next to the exe
// rather than the bunfs root (see ../quayd/resources.ts and daemon/main.ts VENDOR_DIR).
//
// Run from apps/quay:
//   bun daemon/build-exe.ts [--outfile <path>] [--target bun-darwin-arm64|bun-darwin-x64]
// `--target` cross-compiles per arch; omit it to build for the host.
//
// Two bundler plugins, both needed only at build time:
//   • raw-text      — `import x from './y.md?raw'`: the agent imports its prompts as ?raw,
//                     and Bun's BUNDLER (unlike its runtime) has no native ?raw loader.
//   • htmlImportmap — fills the shell HTML's empty `<script type="importmap">` with the
//                     shared vendor map and pins one physical React copy. This is the same
//                     plugin bunfig.toml registers for serve-time HTML bundling.

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import htmlImportmap from './htmlImportmap.ts'

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
	entrypoints: ['./daemon/main.ts'],
	target: 'bun',
	plugins: [rawText, htmlImportmap],
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

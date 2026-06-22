import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { bakeTypes } from '@justfiles/app/devkit-runtime'
import type { Plugin, ResolvedConfig } from 'vite'

// App-code owns the types-only devkit sysroot — the "headers" a draft compiles and
// typechecks against. The host owns the SDK *runtime* (the served `/vendor/<spec>.js`
// modules); app-code ships ONLY the `.d.ts` surface. At build time this plugin bakes the
// SDK + React `.d.ts` into `dist/devkit/types/**` and writes `dist/devkit/index.json`
// (schema + a content hash over every header). `manifest.json`'s `include: ['devkit/**']`
// (vite.config.ts) carries them into the seeded bundle, and the host loads them (Step 6).
//
// There is deliberately NO `external` array and NO `runtime/` here: the SDK allowlist +
// the runtime are the host's (the compiled-in `sdkExternals` constant + the served vendor
// modules). Shipping a copy per-draft would just reintroduce the drift it prevents.

const SCHEMA = 'justfiles.devkit.v1'

// `bakeTypes` keys the overlay as `node_modules/<pkg>/…` (the key tsc resolution needs),
// but we DON'T ship a literal `node_modules` dir (npm/pnpm publish strip it, some tooling
// special-cases it): drop the prefix on disk as `devkit/types/<pkg>/…` and the loader
// prepends it back when building the tsc overlay key.
const NM = 'node_modules/'

export function devkitSysroot(): Plugin {
	let config: ResolvedConfig
	return {
		name: 'app-code:devkit-sysroot',
		apply: 'build',
		configResolved(resolved) {
			config = resolved
		},
		async closeBundle() {
			const root = join(config.root, config.build.outDir, 'devkit')
			await rm(root, { recursive: true, force: true })
			const types = await bakeTypes()
			const digest = createHash('sha256')
			for (const [key, content] of Object.entries(types).sort(([a], [b]) => (a < b ? -1 : 1))) {
				const rel = key.startsWith(NM) ? key.slice(NM.length) : key
				const file = join(root, 'types', rel)
				await mkdir(dirname(file), { recursive: true })
				await writeFile(file, content)
				digest.update(rel).update('\0').update(content).update('\0')
			}
			const index = { schema: SCHEMA, hash: `sha256-${digest.digest('hex')}` }
			await writeFile(join(root, 'index.json'), JSON.stringify(index, null, '\t'))
		}
	}
}

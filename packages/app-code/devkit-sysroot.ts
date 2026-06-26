import { join } from 'node:path'
import { writeSysroot } from '@justfiles/app/devkit-runtime'
import type { Plugin, ResolvedConfig } from 'vite'

// App-code owns the devkit sysroot — the fixed SDK a draft compiles and typechecks
// against. At build time this plugin bakes SDK + React `.d.ts` and SDK runtime JS into
// content-addressed `dist/devkit/store/**` blobs and writes `dist/devkit/index.json`
// (schema + content hash + the logical-path → blob-id maps). `manifest.json`'s
// `include: ['devkit/**']` (vite.config.ts) carries it into the seeded bundle, and the
// host loads it from the calling app's installed bytes.

export function devkitSysroot(): Plugin {
	let config: ResolvedConfig
	return {
		name: 'app-code:devkit-sysroot',
		apply: 'build',
		configResolved(resolved) {
			config = resolved
		},
		async closeBundle() {
			await writeSysroot(join(config.root, config.build.outDir, 'devkit'))
		}
	}
}

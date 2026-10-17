import { resolve } from 'node:path'
import { writeSysroot } from '@justfiles/app/devkit-runtime'
import type { Plugin, ResolvedConfig } from 'vite'

// App Code owns the fixed SDK that a draft compiles and checks against. Build and
// local development write it to `dist/devkit`; `include: ['devkit/**']` puts it in
// the installed Code bundle.

export function devkitSysroot(): Plugin {
	let config: ResolvedConfig
	const write = () => writeSysroot(resolve(config.root, config.build.outDir, 'devkit'))
	return {
		name: 'app-code:devkit-sysroot',
		configResolved(resolved) {
			config = resolved
		},
		async configureServer() {
			await write()
		},
		async closeBundle() {
			if (config.command === 'build') await write()
		}
	}
}

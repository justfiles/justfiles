import { buildRuntime } from '@justfiles/app/devkit-runtime'
import type { Plugin } from 'vite'

// Exposes the pre-bundled devkit system libraries (`@justfiles/app/devkit-runtime`)
// as `import { runtime } from 'virtual:devkit-runtime'`. The browser devkit
// compiler imports this lazily, so the bundled stdlib only loads when an app
// actually compiles a draft.
const ID = 'virtual:devkit-runtime'
const RESOLVED = `\0${ID}`

export function devkitRuntime(): Plugin {
	let cached: Promise<string> | undefined
	return {
		name: 'frieren:devkit-runtime',
		resolveId(id) {
			if (id === ID) return RESOLVED
		},
		load(id) {
			if (id !== RESOLVED) return
			cached ??= buildRuntime().then(
				(runtime) => `export const runtime = ${JSON.stringify(runtime)}\n`
			)
			return cached
		}
	}
}

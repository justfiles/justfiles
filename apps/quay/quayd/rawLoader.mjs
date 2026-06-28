// `@justfiles/agent` authors its system prompts as markdown and imports them as
// strings via the bundler's `?raw` suffix (vite). quayd runs that
// source un-bundled under `node --import tsx`, which has no notion of `?raw`, so
// these synchronous module hooks supply it: resolve the base file, then load it as
// a default-exported string. Registered ahead of tsx (plain `.mjs` so it needs no
// loader of its own) via `--import` in the quayd launch line.

import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const RAW = '?raw'

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (!specifier.endsWith(RAW)) return nextResolve(specifier, context)
		const resolved = nextResolve(specifier.slice(0, -RAW.length), context)
		return { ...resolved, url: resolved.url + RAW, format: 'raw', shortCircuit: true }
	},
	load(url, context, nextLoad) {
		if (!url.endsWith(RAW)) return nextLoad(url, context)
		const source = readFileSync(fileURLToPath(url.slice(0, -RAW.length)), 'utf8')
		return {
			format: 'module',
			source: `export default ${JSON.stringify(source)}`,
			shortCircuit: true
		}
	}
})

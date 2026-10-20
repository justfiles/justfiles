import { build } from 'esbuild'

// The shipped `ghost`: the CLI and the daemon as one ESM file run by the user's node, with
// every import resolved here, so nothing sits beside it. CommonJS dependencies inside it
// still `require` node's built-ins, which an ES module has no `require` for.
await build({
	entryPoints: ['cli.ts'],
	outfile: 'dist/ghost.mjs',
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22.19',
	logLevel: 'warning',
	banner: {
		js: [
			'#!/usr/bin/env node',
			"import { createRequire as __ghostRequire } from 'node:module'",
			'const require = __ghostRequire(import.meta.url)'
		].join('\n')
	}
})

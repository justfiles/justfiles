import { resolve } from 'node:path'
import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm'],
	platform: 'node',
	banner: { js: '#!/usr/bin/env node' },
	clean: true,
	alias: {
		'@justfiles/core/fs.client': resolve(
			import.meta.dirname,
			'../../packages/core/src/fs.client.ts'
		)
	},
	deps: {
		alwaysBundle: [/^hono($|\/)/, /^@justfiles\//]
	}
})

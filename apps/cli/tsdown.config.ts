import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm'],
	platform: 'node',
	deps: {
		alwaysBundle: [/^@justfiles\/fs(?:\/.*)?$/],
	},
	banner: { js: '#!/usr/bin/env node' },
	clean: true,
})

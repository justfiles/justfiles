import { defineConfig } from 'tsdown'
import pkg from './package.json' with { type: 'json' }

const entry: Record<string, string> = Object.fromEntries(
	Object.values(pkg.exports).map((file) => {
		if (typeof file !== 'string') {
			throw new Error('Each export entry must be a source path string')
		}
		const stem = file.replace(/^\.\//, '').replace(/\.ts$/, '')
		return [stem, `./${stem}.ts`]
	})
)
entry.cli = './cli.ts'

export default defineConfig({
	entry,
	format: ['esm'],
	platform: 'neutral',
	dts: true,
	clean: true,
	banner: { js: '#!/usr/bin/env node' }
})

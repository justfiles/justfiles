import { defineConfig } from 'tsdown'
import pkg from './package.json' with { type: 'json' }

type ExportTarget = {
	import?: string
}

const entry: Record<string, string> = Object.fromEntries(
	Object.values(pkg.exports).map((target) => {
		const file = (target as ExportTarget).import
		if (!file) {
			throw new Error('Each export entry must define an import target')
		}
		const stem = file
			.replace(/^\.\//, '')
			.replace(/^dist\//, '')
			.replace(/\.js$/, '')
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
	banner: { js: '#!/usr/bin/env node' },
	deps: {
		alwaysBundle: [/^@justfiles\//]
	},
	inputOptions(options) {
		options.resolve ??= {}
		options.resolve.conditionNames = ['@justfiles/src', 'import', 'default']
		return options
	}
})

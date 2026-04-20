import { defineConfig } from 'tsdown'
import pkg from './package.json' with { type: 'json' }

type ExportTarget = {
	import?: string
}

// Derive entry points from the exports field so package.json stays
// the single source of truth. The package exports point at dist/*.js,
// while tsdown expects source entry files.
const entry = Object.fromEntries(
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

export default defineConfig({
	entry,
	format: ['esm'],
	platform: 'neutral',
	dts: true,
	clean: true
})

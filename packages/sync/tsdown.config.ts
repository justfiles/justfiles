import { defineConfig } from 'tsdown'
import pkg from './package.json' with { type: 'json' }

const entry = Object.fromEntries(
	Object.values(pkg.exports).map((file) => {
		const stem = file.replace(/^\.\//, '').replace(/\.ts$/, '')
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

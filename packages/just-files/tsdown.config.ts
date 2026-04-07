import { defineConfig } from 'tsdown'
import pkg from './package.json' with { type: 'json' }

// Derive entry points from the exports field so package.json stays
// the single source of truth. Values are like "./storage.mem.ts".
const entry = Object.fromEntries(
	Object.values(pkg.exports).map((file) => {
		const stem = file.replace(/^\.\//, '').replace(/\.ts$/, '')
		return [stem, file]
	})
)

export default defineConfig({
	entry,
	format: ['esm'],
	platform: 'neutral',
	dts: true,
	clean: true,
})

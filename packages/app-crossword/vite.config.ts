import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig } from 'vite'

export default defineConfig({
	resolve: {
		conditions: ['@justfiles/src', ...defaultClientConditions]
	},
	plugins: [react()],
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		// Bundle the app as a single ESM module the host can `import()`.
		// Per app platform doctrine (issue #117): each app bundles its own
		// framework so its deployment is independent of the host's React
		// version.
		lib: {
			entry: 'src/main.tsx',
			formats: ['es'],
			fileName: () => 'main.js'
		}
	}
})

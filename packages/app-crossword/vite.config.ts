import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig } from 'vite'

export default defineConfig({
	resolve: {
		conditions: ['@justfiles/src', ...defaultClientConditions]
	},
	// The lib bundle is loaded directly by the host via `import()` in the
	// browser — there is no downstream bundler to replace `process.env.*`,
	// so we inline it here. React 19 reads `process.env.NODE_ENV` at module
	// load; without this, the entry throws `ReferenceError: process is not
	// defined` before `mount()` can run.
	define: {
		'process.env.NODE_ENV': JSON.stringify('production')
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

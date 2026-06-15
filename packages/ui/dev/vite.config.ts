import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev playground for developing @justfiles/ui in isolation, with Vite HMR. Run
// from the package: `pnpm --filter @justfiles/ui dev` (or `pnpm dev` in here).
// Vite resolves a relative `root` against the cwd, and the dev script always runs
// from the package root, so 'dev' points at this directory (dev/index.html entry).
export default defineConfig({
	root: 'dev',
	plugins: [react()],
	server: { port: 5180 }
})

import path from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import { hostApps } from '@justfiles/app/vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src')
		}
	},
	plugins: [
		tailwindcss(),
		react(),
		cloudflare(),
		// Client-only apps are referenced by package name because they
		// have no JS module to import.
		hostApps(['@justbuddy/app-doom', '@justfiles/app-crossword', '@justfiles/app-demo'])
		// `packages/app-hello` is a kernel-app SDK fixture (defineApp +
		// defineGUI) — kept as a known-good bundle for kernel.test.ts and the
		// future drag-drop install flow. It is not shipped/auto-installed: the
		// kernel system runs user-installed apps, and built-in features live
		// in `src/` like settings (no kernel involved).
	]
})

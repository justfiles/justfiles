import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
	main: {
		build: {
			externalizeDeps: {
				exclude: [
					'@justfiles/agent',
					'@justfiles/app',
					'@justfiles/fs',
					'@justfiles/app-code',
					'@justfiles/app-counter',
					'@justfiles/app-files',
					'@justfiles/app-paint',
					'@justfiles/app-settings'
				]
			}
		}
	},
	preload: {
		// A sandboxed preload (`sandbox: true`) can only `require` electron + a few
		// built-ins, so leaving node_modules deps as externals (the default) makes
		// `require('@electron-toolkit/preload')` throw and `window.api` never gets
		// exposed. Bundle them in instead — per electron-vite's sandbox guidance.
		build: { externalizeDeps: false }
	},
	renderer: {
		resolve: {
			alias: {
				'@renderer': resolve('src/renderer/src')
			}
		},
		plugins: [tailwindcss(), react()]
	}
})

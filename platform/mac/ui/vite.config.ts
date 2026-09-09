import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const ROOT = import.meta.dirname

export default defineConfig({
	root: ROOT,
	// Absolute asset URLs so app/shell.html (served at /app/:id) still resolves /assets.
	base: '/',
	build: {
		outDir: 'dist/client',
		emptyOutDir: true,
		rollupOptions: {
			input: {
				launcher: resolve(ROOT, 'launcher/index.html'),
				chat: resolve(ROOT, 'launcher/chat.html'),
				store: resolve(ROOT, 'launcher/store.html'),
				settings: resolve(ROOT, 'launcher/settings.html'),
				shell: resolve(ROOT, 'app/shell.html')
			}
		}
	},
	plugins: [react()]
})

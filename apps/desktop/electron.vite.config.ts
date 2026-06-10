import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
	main: {
		build: {
			externalizeDeps: { exclude: ['@justfiles/agent', '@justfiles/app', '@justfiles/fs'] }
		}
	},
	preload: {},
	renderer: {
		resolve: {
			alias: {
				'@renderer': resolve('src/renderer/src')
			}
		},
		plugins: [tailwindcss(), react()]
	}
})

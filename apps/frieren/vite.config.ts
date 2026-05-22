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
	plugins: [tailwindcss(), react(), cloudflare(), hostApps([])]
})

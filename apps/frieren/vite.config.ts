import path from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import { hostApps } from '@justfiles/app/vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig } from 'vite'
import crossword from '@justfiles/app-crossword'

// https://vite.dev/config/
export default defineConfig({
	resolve: {
		conditions: ['@justfiles/src', ...defaultClientConditions],
		alias: {
			'@': path.resolve(__dirname, './src')
		}
	},
	plugins: [tailwindcss(), react(), cloudflare(), hostApps([crossword])]
})

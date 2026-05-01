import { appBuilder } from '@justfiles/app/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [appBuilder()]
})

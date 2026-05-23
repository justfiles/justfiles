import { kernelHost } from '@justfiles/app/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		kernelHost({
			id: 'app.justbuddy.doom',
			name: 'Doom',
			app: 'src/app.ts',
			gui: 'src/gui.ts'
		})
	]
})

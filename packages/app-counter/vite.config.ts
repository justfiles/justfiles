import { kernelHost } from '@justfiles/app/kernel/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		kernelHost({
			id: 'app.justfiles.counter',
			name: 'app-counter',
			app: 'src/app.ts',
			gui: 'src/gui.ts'
		})
	]
})

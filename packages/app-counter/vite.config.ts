import { kernelHost } from '@justfiles/app/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		kernelHost({
			id: 'computer.spud.counter',
			name: 'app-counter',
			app: 'src/app.ts',
			gui: 'src/gui.ts'
		})
	]
})

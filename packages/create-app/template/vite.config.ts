import { kernelHost } from '@justfiles/app/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		kernelHost({
			id: 'app.example.counter',
			name: 'Counter',
			description: 'A tiny kernel app.',
			app: 'src/app.ts',
			gui: 'src/gui.ts'
		})
	]
})

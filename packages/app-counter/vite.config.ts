import { kernelHost } from '@justfiles/app/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		kernelHost({
			id: 'computer.spud.counter',
			name: 'Counter',
			description: 'A tiny counter app — the spud store canary.',
			app: 'src/app.ts',
			gui: 'src/gui.ts'
		})
	]
})

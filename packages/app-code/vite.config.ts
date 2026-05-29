import { kernelHost } from '@justfiles/app/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		kernelHost({
			id: 'app.example.code',
			name: 'Code',
			description: 'A mock IDE layout.',
			app: 'src/app.ts',
			gui: 'src/gui.ts'
		})
	]
})

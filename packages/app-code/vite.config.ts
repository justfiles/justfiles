import { kernelHost } from '@justfiles/app/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		kernelHost({
			id: 'app.code',
			name: 'Code',
			icon: 'icon.svg',
			description: 'Build Frieren apps inside Frieren.',
			app: 'src/app.ts',
			gui: 'src/gui.tsx'
		})
	]
})

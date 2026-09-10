import { kernelHost } from '@justfiles/app/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
	resolve: { dedupe: ['react', 'react-dom'] },
	plugins: [
		react(),
		...(mode === 'test'
			? []
			: [
					kernelHost({
						id: '__APP_ID__',
						name: '__APP_NAME__',
						description: 'A tiny kernel app.',
						app: 'src/app.ts',
						gui: 'src/gui.tsx'
					})
				])
	]
}))

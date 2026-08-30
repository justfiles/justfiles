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
						id: 'justfiles.reading',
						name: 'Reading',
						description: 'Save clean copies of articles and documents to read later.',
						icon: 'icon.svg',
						app: 'src/app.ts',
						gui: 'src/gui.tsx'
					})
				])
	]
}))

import { kernelHost } from '@justfiles/app/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
	define: { 'process.env.NODE_ENV': JSON.stringify('production') },
	plugins: [
		react(),
		...(mode === 'test'
			? []
			: [
					kernelHost({
						id: 'computer.spud.crossword',
						name: 'Crossword',
						app: 'src/app.ts',
						gui: 'src/gui.tsx'
					})
				])
	]
}))

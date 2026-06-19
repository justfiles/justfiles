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
						id: 'app.example.counter',
						name: 'Counter',
						description: 'A tiny kernel app.',
						app: 'src/app.ts',
						gui: 'src/gui.tsx'
					})
				])
	]
}))

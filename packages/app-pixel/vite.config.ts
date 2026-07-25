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
						id: 'app.justfiles.frieren.pixel',
						name: 'Pixel',
						description:
							'Indexed pixel-art editor — a palette-indexed canvas you draw in or drive with an agent.',
						icon: 'icon.png',
						app: 'src/app.ts',
						gui: 'src/gui.tsx'
					})
				])
	]
}))

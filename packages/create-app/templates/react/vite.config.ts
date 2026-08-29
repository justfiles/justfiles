// biome-ignore lint/correctness/noUnusedImports: The commented template line uses devAi.
import { devAi, kernelHost } from '@justfiles/app/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
	resolve: { dedupe: ['react', 'react-dom'] },
	plugins: [
		react(),
		...(mode === 'test'
			? []
			: [
					// Uncomment to use an installed AI CLI or local OpenAI-compatible server.
					// devAi(),
					kernelHost({
						id: 'alice.counter',
						name: 'Counter',
						description: 'A tiny kernel app.',
						app: 'src/app.ts',
						gui: 'src/gui.tsx'
					})
				])
	]
}))

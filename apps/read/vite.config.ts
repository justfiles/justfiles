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
						id: 'justfiles.read',
						name: 'Read',
						description: 'Save clean copies of articles and documents to read later.',
						icon: 'icon.svg',
						imports: {
							react: 'https://esm.sh/react@19.2.8',
							'react/jsx-runtime': 'https://esm.sh/react@19.2.8/jsx-runtime',
							'react-dom/client': 'https://esm.sh/react-dom@19.2.8/client?deps=react@19.2.8'
						},
						app: 'src/app.ts',
						gui: 'src/gui.tsx'
					})
				])
	]
}))

import { kernelHost } from '@justfiles/app/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
	// ONE React per artifact. `gui.js` inlines the framework, and pnpm can resolve
	// this app's React and a React-based dependency's to two different copies. Two
	// Reacts in one bundle means the renderer sets the hook dispatcher on an instance
	// the components never read, and the GUI dies on its first `useState`.
	resolve: { dedupe: ['react', 'react-dom'] },
	plugins: [
		react(),
		...(mode === 'test'
			? []
			: [
					kernelHost({
						id: 'justfiles.settings',
						name: 'Settings',
						description: 'Connect accounts and choose what they power',
						icon: 'icon.svg',
						app: 'src/app.ts',
						gui: 'src/gui.tsx'
					})
				])
	]
}))

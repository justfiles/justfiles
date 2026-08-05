import { kernelHost } from '@justfiles/app/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
	// ONE React per artifact. `gui.js` inlines the framework, and pnpm can resolve
	// this app's React and a React-based dependency's to two different copies. Two
	// Reacts in one bundle means the renderer sets the hook dispatcher on an instance
	// the components never read, and the GUI dies on its first `useState`.
	resolve: { dedupe: ['react', 'react-dom'] },
	// The host mounts an app by reading ONLY `gui.js` and importing it as a Blob
	// URL, so relative chunk fetches have no origin to resolve against. Excalidraw
	// code-splits heavily (locales, mermaid, fonts); inline every dynamic import
	// so the GUI is a single self-contained module.
	build: { rollupOptions: { output: { codeSplitting: false } } },
	plugins: [
		react(),
		...(mode === 'test'
			? []
			: [
					kernelHost({
						id: 'app.justfiles.frieren.draw',
						name: 'Draw',
						description: 'A freeform sketchpad backed by Excalidraw',
						icon: 'icon.png',
						app: 'src/app.ts',
						gui: 'src/gui.tsx'
					})
				])
	]
}))

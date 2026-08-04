import { kernelHost } from '@justfiles/app/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
	define: { 'process.env.NODE_ENV': JSON.stringify('production') },
	// The GUI wrapper's react-dom (the renderer) and our component must resolve
	// the SAME react instance, or the renderer sets the hook dispatcher on a react
	// our hooks never read → "invalid hook call". Dedupe collapses them to one.
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

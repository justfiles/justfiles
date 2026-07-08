import { kernelHost } from '@justfiles/app/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// kernelHost externalizes react/react-dom so apps share the host's single
// importmap instance. That works for pure-ESM apps, but Excalidraw drags in a
// CJS dep (use-sync-external-store, via jotai) that does `require("react")`;
// against an EXTERNAL react, rolldown emits a runtime require() that throws in
// the browser. So this app bundles react instead: it mounts in its own isolated
// root with only serialized state crossing the transport, so a self-contained
// react (one instance for the wrapper, our component, and Excalidraw alike) is
// correct — and the CJS require resolves to a real module. See
// docs/app-bundling-pitfalls.md §3a.
const bundleReact = (): Plugin => ({
	name: 'app-draw:bundle-react',
	configResolved(config) {
		const ext = config.build.rollupOptions.external
		if (Array.isArray(ext)) {
			config.build.rollupOptions.external = ext.filter((e) => !String(e).startsWith('react'))
		}
	}
})

export default defineConfig(({ mode }) => ({
	define: { 'process.env.NODE_ENV': JSON.stringify('production') },
	// The GUI wrapper's react-dom (the renderer) and our component must resolve
	// the SAME react instance, or the renderer sets the hook dispatcher on a react
	// our hooks never read → "invalid hook call". Dedupe collapses them to one.
	resolve: { dedupe: ['react', 'react-dom'] },
	// The host mounts an app by reading ONLY `gui.js` and importing it as a Blob
	// URL, so relative chunk fetches have no origin to resolve against. Excalidraw
	// code-splits heavily (locales, mermaid, fonts); inline every dynamic import
	// so the GUI is a single self-contained module. See app-bundling-pitfalls §2.
	build: { rollupOptions: { output: { codeSplitting: false } } },
	plugins: [
		react(),
		...(mode === 'test'
			? []
			: [
					bundleReact(),
					kernelHost({
						id: 'computer.spud.draw',
						name: 'Draw',
						description: 'A freeform sketchpad backed by Excalidraw',
						icon: 'icon.png',
						app: 'src/app.ts',
						gui: 'src/gui.tsx'
					})
				])
	]
}))

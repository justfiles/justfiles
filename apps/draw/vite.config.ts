import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { kernelHost } from '@justfiles/app/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const require = createRequire(import.meta.url)
const fontDirectory = join(dirname(require.resolve('@excalidraw/excalidraw')), 'fonts')

export function inlineExcalidrawFonts(code: string) {
	for (const relativePath of readdirSync(fontDirectory, { recursive: true })) {
		if (!relativePath.endsWith('.woff2') || relativePath.startsWith('Xiaolai/')) continue
		const url = `./fonts/${relativePath}`
		if (!code.includes(url)) continue
		const data = readFileSync(join(fontDirectory, relativePath), 'base64')
		code = code.replaceAll(url, `data:font/woff2;base64,${data}`)
	}
	return code
}

export default defineConfig(({ mode }) => ({
	// ONE React per artifact. `gui.js` inlines the framework, and pnpm can resolve
	// this app's React and a React-based dependency's to two different copies. Two
	// Reacts in one bundle means the renderer sets the hook dispatcher on an instance
	// the components never read, and the GUI dies on its first `useState`.
	resolve: { dedupe: ['react', 'react-dom'] },
	// The host mounts an app by reading ONLY `gui.js` and importing it as a Blob
	// URL, so relative chunk fetches have no origin to resolve against. Excalidraw
	// code-splits heavily; inline every dynamic import so the GUI stays one module.
	// The plugin below also embeds every font except the large, network-loaded Xiaolai.
	build: { rollupOptions: { output: { codeSplitting: false } } },
	plugins: [
		react(),
		{
			name: 'inline-excalidraw-fonts',
			generateBundle(_options, bundle) {
				const gui = bundle['gui.js']
				if (gui?.type === 'chunk') gui.code = inlineExcalidrawFonts(gui.code)
			}
		},
		...(mode === 'test'
			? []
			: [
					kernelHost({
						id: 'io.github.justfiles.draw',
						name: 'Draw',
						description: 'A freeform sketchpad backed by Excalidraw',
						icon: 'icon.svg',
						app: 'src/app.ts',
						gui: 'src/gui.tsx'
					})
				])
	]
}))

// No framework: the GUI is plain DOM through `defineGUI` (see `src/gui.ts`), so
// there is no UI plugin and no JSX. Bring your own — add the framework and its
// Vite plugin here and it bundles into `gui.js`; the platform serves no framework
// bytes either way.
// biome-ignore lint/correctness/noUnusedImports: The commented template line uses devAi.
import { devAi, kernelHost } from '@justfiles/app/vite'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
	plugins: [
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
						gui: 'src/gui.ts'
					})
				])
	]
}))

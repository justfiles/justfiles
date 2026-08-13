// No React: this app's GUI is plain DOM through `defineGUI` (see `src/gui.ts`),
// so there is no react plugin and no JSX — the bundle carries only the app.
import { kernelHost } from '@justfiles/app/vite'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
	plugins: [
		...(mode === 'test'
			? []
			: [
					kernelHost({
						id: 'justfiles.dictionary',
						name: 'Dictionary',
						description: 'Look up words and short terms, explained for the reader',
						icon: 'icon.png',
						app: 'src/app.ts',
						gui: 'src/gui.ts'
					})
				])
	]
}))

import { devAi, kernelHost } from '@justfiles/app/vite'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
	plugins:
		mode === 'test'
			? []
			: [
					kernelHost({
						id: 'justfiles.dictionary',
						name: 'Dictionary',
						description: 'Look up words and short terms, explained for the reader',
						icon: 'icon.svg',
						app: 'src/app.ts',
						gui: 'src/gui.ts'
					}),
					devAi()
				]
}))

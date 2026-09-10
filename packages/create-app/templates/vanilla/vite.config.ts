import { kernelHost } from '@justfiles/app/vite'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
	plugins: [
		...(mode === 'test'
			? []
			: [
					kernelHost({
						id: '__APP_ID__',
						name: '__APP_NAME__',
						description: 'A tiny kernel app.',
						app: 'src/app.ts',
						gui: 'src/gui.ts'
					})
				])
	]
}))

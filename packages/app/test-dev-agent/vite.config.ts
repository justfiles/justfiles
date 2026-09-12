import { devAi, kernelHost } from '@justfiles/app/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		devAi('claude-cli'),
		kernelHost({
			id: 'test.dev-agent',
			name: 'Dev agent fixture',
			app: 'src/app.ts',
			gui: 'src/gui.ts'
		})
	]
})

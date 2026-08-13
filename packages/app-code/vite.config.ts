import { kernelHost } from '@justfiles/app/vite'
import { defineConfig } from 'vite'
import { devkitSysroot } from './devkit-sysroot.ts'

export default defineConfig({
	// ONE React per artifact. `gui.js` inlines the framework, and pnpm can resolve
	// this app's React and a React-based dependency's to two different copies. Two
	// Reacts in one bundle means the renderer sets the hook dispatcher on an instance
	// the components never read, and the GUI dies on its first `useState`.
	resolve: { dedupe: ['react', 'react-dom'] },
	plugins: [
		kernelHost({
			id: 'justfiles.code',
			name: 'Code',
			icon: 'icon.png',
			description: 'Build and run apps directly in Kodama.',
			app: 'src/app.ts',
			gui: 'src/gui.tsx',
			// Carry the devkit sysroot (`devkit-sysroot.ts` emits dist/devkit/**) into
			// the seeded bundle so the host can load draft SDK runtime + headers.
			include: ['devkit/**']
		}),
		devkitSysroot()
	]
})

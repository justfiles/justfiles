import { kernelHost } from '@justfiles/app/vite'
import { defineConfig } from 'vite'
import { devkitSysroot } from './devkit-sysroot.ts'

export default defineConfig(({ mode }) => ({
	// ONE React per artifact. `gui.js` inlines the framework, and pnpm can resolve
	// this app's React and a React-based dependency's to two different copies. Two
	// Reacts in one bundle means the renderer sets the hook dispatcher on an instance
	// the components never read, and the GUI dies on its first `useState`.
	resolve: { dedupe: ['react', 'react-dom'] },
	// `mode === 'test'` is vitest loading this file for its OWN server. The host must
	// not boot there: vitest inlines `vite` into the module graph it evaluates, and the
	// dev server imports `vite` itself. `dev-server.test.ts` starts a real server of
	// its own, which resolves this config in `development` and does get the plugins.
	plugins:
		mode === 'test'
			? []
			: [
					// First, so `dist/devkit` exists before kernelHost's dev server reads `include`.
					devkitSysroot(),
					kernelHost({
						id: 'justfiles.code',
						name: 'Code',
						icon: 'icon.svg',
						description: 'Build and run apps directly in JustFiles.',
						app: 'src/app.ts',
						gui: 'src/gui.tsx',
						// Carry the devkit sysroot (`devkit-sysroot.ts` emits dist/devkit/**) into
						// the seeded bundle so the host can load draft SDK runtime + headers.
						include: ['devkit/**']
					})
				]
}))

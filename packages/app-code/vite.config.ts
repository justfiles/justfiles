import { kernelHost } from '@justfiles/app/vite'
import { defineConfig } from 'vite'
import { devkitSysroot } from './devkit-sysroot.ts'

export default defineConfig({
	plugins: [
		kernelHost({
			id: 'app.code',
			name: 'Code',
			icon: 'icon.png',
			description: 'Build Frieren apps inside Frieren.',
			app: 'src/app.ts',
			gui: 'src/gui.tsx',
			// Carry the types-only devkit sysroot (`devkit-sysroot.ts` emits dist/devkit/**)
			// into the seeded bundle so the host can load the draft headers.
			include: ['devkit/**']
		}),
		devkitSysroot()
	]
})

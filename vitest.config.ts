import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: [
			'apps/frieren/worker/**/*.test.ts',
			'apps/frieren/shared/**/*.test.ts',
			'apps/frieren/src/os/**/*.test.ts',
			'apps/frieren/src/apps/**/*.test.ts',
			'apps/worker/**/*.test.ts',
			'packages/*/**/*.test.ts',
			'packages/*/**/*.test.tsx'
		],
		exclude: ['**/node_modules/**', '**/dist/**', 'apps/frieren/src/!(os|apps)/**']
	}
})

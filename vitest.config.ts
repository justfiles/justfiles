import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: [
			'apps/frieren/worker/**/*.test.ts',
			'apps/frieren/shared/**/*.test.ts',
			'apps/frieren/src/os/**/*.test.ts',
			'apps/frieren/src/apps/**/*.test.ts',
			'apps/frieren/src/agent/**/*.test.ts',
			'apps/frieren/src/notifications/**/*.test.ts',
			'apps/worker/**/*.test.ts',
			'apps/mac/**/*.test.ts',
			'packages/*/**/*.test.ts',
			'packages/*/**/*.test.tsx'
		],
		// `*.bun.test.ts` runs under `bun test` (it needs the Bun runtime: `Bun.build`,
		// `bun:test`) — the CI matrix's Bun half. The node vitest run skips it.
		exclude: [
			'**/node_modules/**',
			'**/dist/**',
			'**/*.bun.test.ts',
			'apps/frieren/src/!(os|apps|agent|notifications)/**'
		]
	}
})

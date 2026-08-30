import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: [
			'apps/crossword/**/*.test.ts',
			'apps/read/**/*.test.ts',
			'apps/doom/**/*.test.ts',
			'apps/pixel/**/*.test.ts',
			'platform/shared/**/*.test.ts',
			'platform/frieren/scripts/**/*.test.ts',
			'platform/frieren/worker/**/*.test.ts',
			'platform/frieren/shared/**/*.test.ts',
			'platform/frieren/src/os/**/*.test.ts',
			'platform/frieren/src/apps/**/*.test.ts',
			'platform/frieren/src/agent/**/*.test.ts',
			'platform/frieren/src/notifications/**/*.test.ts',
			'platform/worker/**/*.test.ts',
			'platform/mac/**/*.test.ts',
			'platform/runner/**/*.test.ts',
			'packages/*/**/*.test.ts',
			'packages/*/**/*.test.tsx'
		],
		// `*.bun.test.ts` runs under `bun test` (it needs the Bun runtime: `Bun.build`,
		// `bun:test`) — the CI matrix's Bun half. The node vitest run skips it.
		exclude: [
			'**/node_modules/**',
			'**/dist/**',
			'**/*.bun.test.ts',
			'platform/frieren/src/!(os|apps|agent|notifications)/**'
		]
	}
})

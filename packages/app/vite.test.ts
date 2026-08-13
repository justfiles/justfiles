import { resolveConfig } from 'vite'
import { expect, test } from 'vitest'
import { kernelHost } from './vite.ts'

test('dev scans the GUI hidden behind the generated page', async () => {
	const config = await resolveConfig(
		{
			configFile: false,
			plugins: kernelHost({
				id: 'app.test',
				name: 'Test',
				app: 'src/app.ts',
				gui: 'src/gui.tsx'
			})
		},
		'serve'
	)

	expect(config.optimizeDeps.entries).toEqual(['src/gui.tsx'])
})

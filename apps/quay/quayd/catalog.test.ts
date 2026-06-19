import type { Kernel } from '@justfiles/app/runtime'
import { expect, test } from 'vitest'
import { launcherCatalog } from './catalog.ts'

function mockKernel(): Pick<Kernel, 'list'> {
	return {
		list: async () => [
			{ id: 'app.frieren.notes', name: 'Notes', icon: 'icon.svg', app: 'app.js' },
			{ id: 'preview.notes', name: 'Preview', icon: 'icon.svg', app: 'app.js' }
		]
	}
}

test('launcher catalog is lightweight and excludes preview apps', async () => {
	expect(await launcherCatalog(mockKernel())).toEqual([
		{
			id: 'app.frieren.notes',
			name: 'Notes',
			glyph: 'N'
		}
	])
})

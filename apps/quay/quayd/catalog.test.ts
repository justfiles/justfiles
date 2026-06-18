import type { Kernel } from '@justfiles/app/runtime'
import { expect, test } from 'vitest'
import { launcherCatalog } from './catalog.ts'

const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'

function mockKernel(): Pick<Kernel, 'list' | 'app'> {
	return {
		list: async () => [
			{ id: 'app.frieren.notes', name: 'Notes', icon: 'icon.svg', app: 'app.js' },
			{ id: 'preview.notes', name: 'Preview', icon: 'icon.svg', app: 'app.js' }
		],
		app: async (id) => ({
			manifest: { id, name: id, icon: 'icon.svg', app: 'app.js' },
			read: async () => new TextEncoder().encode(svg)
		})
	}
}

test('launcher catalog includes installed app icons as data URLs', async () => {
	expect(await launcherCatalog(mockKernel())).toEqual([
		{
			id: 'app.frieren.notes',
			name: 'Notes',
			glyph: 'N',
			icon: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
		}
	])
})

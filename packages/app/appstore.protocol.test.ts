import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { appHash, releaseManifest } from './appstore.protocol.ts'

const files = [
	{ path: 'gui.js', hash: 'sha256-gui', size: 3 },
	{ path: 'app.js', hash: 'sha256-app', size: 2 }
]

test('appHash folds sorted paths and hashes without changing the input', async () => {
	const expected = createHash('sha256')
		.update('app.js\0sha256-app\ngui.js\0sha256-gui')
		.digest('hex')

	expect(await appHash(files)).toBe(expected)
	expect(files.map(({ path }) => path)).toEqual(['gui.js', 'app.js'])
})

test('releaseManifest copies only authored public fields', () => {
	const manifest = releaseManifest(
		{
			id: 'claimed.id',
			name: 'Test',
			description: 'A test app',
			version: 'claimed',
			icon: 'icon.svg',
			app: 'app.js',
			gui: 'gui.js',
			include: ['private/**'],
			baseUrl: 'https://claimed.example/',
			hash: 'claimed',
			files: { 'private.txt': 'claimed' }
		},
		{ id: 'owned.id', version: '1.2.3', hash: 'owned', files }
	)

	expect(manifest).toEqual({
		schema: 'justapps/manifest/v1',
		id: 'owned.id',
		name: 'Test',
		description: 'A test app',
		version: '1.2.3',
		icon: 'icon.svg',
		app: 'app.js',
		gui: 'gui.js',
		cli: undefined,
		capabilities: undefined,
		hash: 'owned',
		files: [files[1], files[0]]
	})
})

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { builtinStoreFromFs } from './appstore.fs.ts'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
	roots.length = 0
})

describe('builtinStoreFromFs', () => {
	test('builds a catalog from manifest entries and include globs', async () => {
		const root = await tempRoot()
		await write(root, 'manifest.json', {
			id: 'app.test',
			name: 'Test',
			version: '1.2.3',
			app: 'app.js',
			gui: 'gui.js',
			icon: 'icon.png',
			include: ['devkit/**']
		})
		await write(root, 'app.js', 'app')
		await write(root, 'gui.js', 'gui')
		await write(root, 'icon.png', 'icon')
		await write(root, 'devkit/types/index.d.ts', 'types')
		await write(root, 'devkit/manifest.json', '{}')
		await write(root, 'bundle.js', 'generated')
		await write(root, 'extra.js', 'extra')

		const store = await builtinStoreFromFs([root])
		const [app] = await store.builtins()

		expect(app?.id).toBe('app.test')
		expect(app?.files.map((file) => file.path)).toEqual([
			'app.js',
			'devkit/manifest.json',
			'devkit/types/index.d.ts',
			'gui.js',
			'icon.png',
			'manifest.json'
		])
		expect(await store.latest('app.test')).toEqual(app)
		expect(await store.latest('app.missing')).toBeNull()
		const bytes = await store.read(app!, 'devkit/types/index.d.ts')
		expect(new TextDecoder().decode(bytes)).toBe('types')
		await expect(store.read(app!, 'extra.js')).rejects.toThrow(/builtin not found/)
	})

	test('fails clearly when a root is not built', async () => {
		const root = await tempRoot()
		await expect(builtinStoreFromFs([root])).rejects.toThrow(/build the app first/)
	})
})

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'justfiles-builtins-'))
	roots.push(root)
	return root
}

async function write(root: string, path: string, content: string | object): Promise<void> {
	const file = join(root, ...path.split('/'))
	await mkdir(dirname(file), { recursive: true })
	await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
}

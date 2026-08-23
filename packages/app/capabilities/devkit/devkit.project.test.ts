import type { Volume } from '@justfiles/fs'
import { describe, expect, test, vi } from 'vitest'

vi.mock('@justfiles/fs', () => ({ chroot: vi.fn() }))
vi.mock('@justfiles/fs/types', () => ({ FileType: { File: 0, Directory: 1, Symlink: 2 } }))
vi.mock('../../kernel.ts', () => ({
	appBundleFromMemory: vi.fn(),
	safeBundlePath: (path: string) => path
}))

import { DEVKIT_LOCK_FILE, readProject, writeImportLock } from './devkit.ts'
import type { ImportLock } from './imports.ts'

const encoder = new TextEncoder()
const root = '/projects/example'
const project = {
	id: 'app.example',
	name: 'Example',
	app: 'src/app.ts',
	imports: { react: 'https://esm.sh/react@19.1.1' }
}
const lock: ImportLock = {
	version: 1,
	redirects: {},
	remote: {
		'https://esm.sh/react@19.1.1': `sha256-${'0'.repeat(64)}`
	}
}

describe('Devkit project imports', () => {
	test('reads imports and keeps the lock out of project source', async () => {
		const fs = memoryVolume()
		await seed(fs, project)
		await writeImportLock(fs, 'example', lock)

		const result = await readProject(fs, 'example')

		expect(result.imports).toEqual(project.imports)
		expect(result.lock).toEqual(lock)
		expect(result.input.files).toEqual({ 'src/app.ts': 'export {}' })
	})

	test('rejects an invalid import map in project.json', async () => {
		const fs = memoryVolume()
		await seed(fs, { ...project, imports: { react: 'https://esm.sh/react' } })

		await expect(readProject(fs, 'example')).rejects.toThrow(/pinned/)
	})

	test('rejects an invalid lock file', async () => {
		const fs = memoryVolume()
		await seed(fs, project)
		await fs.writeFile(`${root}/${DEVKIT_LOCK_FILE}`, encoder.encode('{}'))

		await expect(readProject(fs, 'example')).rejects.toThrow(/invalid/)
	})

	test('enables React JSX only when the project requests it', async () => {
		const fs = memoryVolume()
		await seed(fs, { ...project, compiler: { jsx: 'react-jsx' } })

		const result = await readProject(fs, 'example')

		expect(result.input.tsconfig.compilerOptions?.jsx).toBe('react-jsx')
	})

	test('rejects an unknown compiler JSX mode', async () => {
		const fs = memoryVolume()
		await seed(fs, { ...project, compiler: { jsx: 'preserve' } })

		await expect(readProject(fs, 'example')).rejects.toThrow(/compiler\.jsx/)
	})
})

async function seed(
	fs: ReturnType<typeof memoryVolume>,
	manifest: Record<string, unknown>
): Promise<void> {
	await fs.writeFile(`${root}/project.json`, encoder.encode(JSON.stringify(manifest)))
	await fs.writeFile(`${root}/src/app.ts`, encoder.encode('export {}'))
}

function memoryVolume() {
	const files = new Map<string, Uint8Array>()
	return {
		async exists(path: string) {
			return files.has(path) || [...files].some(([file]) => file.startsWith(`${path}/`))
		},
		async readFile(path: string) {
			const value = files.get(path)
			if (!value) throw new Error(`missing file: ${path}`)
			return value
		},
		async writeFile(path: string, value: Uint8Array) {
			files.set(path, value)
		},
		async scan(path: string, visit: (file: string, stat: { type: number }) => Promise<void>) {
			for (const file of files.keys()) {
				if (file.startsWith(`${path}/`)) await visit(file, { type: 0 })
			}
		}
	} as unknown as Volume
}

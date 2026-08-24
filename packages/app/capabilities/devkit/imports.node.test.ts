import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { diskImportCache } from './imports.node.ts'

test('the disk import cache survives a new cache instance', async () => {
	const root = await mkdtemp(join(tmpdir(), 'devkit-import-cache-'))
	try {
		const url = 'https://esm.sh/example@1.0.0'
		await diskImportCache(root).put(url, { url, text: 'export {}' })

		expect(await diskImportCache(root).get(url)).toEqual({ url, text: 'export {}' })
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('concurrent cache instances publish one complete entry', async () => {
	const root = await mkdtemp(join(tmpdir(), 'devkit-import-cache-'))
	try {
		const url = 'https://esm.sh/example@1.0.0'
		const values = [
			{ url, text: 'export const value = 1' },
			{ url, text: 'export const value = 2' }
		]
		await Promise.all(values.map((value) => diskImportCache(root).put(url, value)))

		expect(values).toContainEqual(await diskImportCache(root).get(url))
		expect(await readdir(root)).toHaveLength(1)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

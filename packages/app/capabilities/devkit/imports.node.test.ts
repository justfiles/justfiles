import { mkdtemp, rm } from 'node:fs/promises'
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

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CachedImport, ImportCache } from './imports.ts'

export function diskImportCache(root = join(tmpdir(), 'justfiles-devkit-imports-v1')): ImportCache {
	const pathFor = (url: string) => join(root, createHash('sha256').update(url).digest('hex'))
	return {
		async get(url) {
			try {
				const value = JSON.parse(await readFile(pathFor(url), 'utf8')) as CachedImport
				if (typeof value.url !== 'string' || typeof value.text !== 'string') {
					throw new Error('invalid entry')
				}
				return value
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
				throw new Error(`Cannot read the Devkit import cache for ${url}`, { cause: error })
			}
		},
		async put(url, value) {
			await mkdir(root, { recursive: true })
			const path = pathFor(url)
			const temp = `${path}.${randomUUID()}.tmp`
			try {
				await writeFile(temp, JSON.stringify(value))
				await rename(temp, path)
			} finally {
				await rm(temp, { force: true })
			}
		}
	}
}

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findLocalTasksDir } from './index.ts'

const dirs: string[] = []

async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), 'tasks-local-'))
	dirs.push(dir)
	return dir
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('findLocalTasksDir', () => {
	test('resolves nearest tasks directory from cwd', async () => {
		const root = await tempDir()
		await mkdir(join(root, 'tasks'), { recursive: true })
		await mkdir(join(root, 'a', 'tasks'), { recursive: true })
		await mkdir(join(root, 'a', 'b'), { recursive: true })
		expect(await findLocalTasksDir(join(root, 'a', 'b'))).toBe(join(root, 'a', 'tasks'))
	})

	test('stops at git root', async () => {
		const root = await tempDir()
		await mkdir(join(root, '.git'), { recursive: true })
		await mkdir(join(root, 'parent', 'tasks'), { recursive: true })
		await mkdir(join(root, 'child'), { recursive: true })
		expect(await findLocalTasksDir(join(root, 'child'))).toBeNull()
	})
})

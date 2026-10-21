import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '@justfiles/ghost'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadCustomTools, withCustomTools } from './custom.ts'

const tool = (name: string, body = `async execute() { return { text: '${name}' } }`) =>
	`{ name: '${name}', description: '${name} tool', parameters: { type: 'object' }, ${body} }`

describe('loadCustomTools', () => {
	let dir: string
	beforeEach(async () => {
		dir = join(await mkdtemp(join(tmpdir(), 'ghost-tools-')), 'tools')
	})
	afterEach(() => rm(join(dir, '..'), { recursive: true }))

	it('is empty without a directory', async () => {
		expect(await loadCustomTools(dir, { root: '/r' })).toEqual([])
	})

	it('loads a tool, a list and a factory given the root, in file name order', async () => {
		await mkdir(dir)
		await writeFile(join(dir, 'b.ts'), `export default ${tool('b')}\n`)
		await writeFile(join(dir, 'a.mjs'), `export default [${tool('a1')}, ${tool('a2')}]\n`)
		await writeFile(
			join(dir, 'c.js'),
			`export default async ({ root }) => [${tool('c1', 'async execute() { return { text: root } }')}, ${tool('c2')}]\n`
		)
		await writeFile(join(dir, 'notes.md'), 'not a module\n')
		await writeFile(join(dir, 'types.d.ts'), 'export type X = 1\n')
		const tools = await loadCustomTools(dir, { root: '/volume' })
		expect(tools.map(({ name }) => name)).toEqual(['a1', 'a2', 'b', 'c1', 'c2'])
		const ctx = { signal: new AbortController().signal, cwd: '/' }
		expect(await tools[3].execute({}, ctx)).toEqual({ text: '/volume' })
	})

	it('names a file that is not a tool, beside a tool and a factory of two', async () => {
		await mkdir(dir)
		await writeFile(join(dir, 'a.ts'), `export default ${tool('a')}\n`)
		await writeFile(join(dir, 'b.ts'), `export default () => [${tool('b1')}, ${tool('b2')}]\n`)
		await writeFile(join(dir, 'c.ts'), `export default { name: 'c' }\n`)
		await expect(loadCustomTools(dir, { root: '/r' })).rejects.toThrow(
			/c\.ts does not export a tool/
		)
		await rm(join(dir, 'c.ts'))
		const tools = await loadCustomTools(dir, { root: '/r' })
		expect(tools.map(({ name }) => name)).toEqual(['a', 'b1', 'b2'])
	})

	it('names a file that does not load', async () => {
		await mkdir(dir)
		await writeFile(join(dir, 'broken.ts'), `export default (\n`)
		await expect(loadCustomTools(dir, { root: '/r' })).rejects.toThrow(
			/cannot load the tool .*broken\.ts/
		)
	})
})

describe('withCustomTools', () => {
	it('lets a custom tool take a built-in one’s place by name', () => {
		const make = (name: string): Tool => ({
			name,
			description: name,
			parameters: {},
			execute: async () => ({ text: name })
		})
		const custom = make('open')
		const result = withCustomTools([make('bash'), make('open')], [custom, make('fetch')])
		expect(result.map(({ name }) => name)).toEqual(['bash', 'open', 'fetch'])
		expect(result[1]).toBe(custom)
	})
})

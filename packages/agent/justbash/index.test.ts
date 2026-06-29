import { type Volume, volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { describe, expect, test } from 'vitest'
import { createJustBashTool, type ShellCommand } from './index.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0]?.text ?? ''

async function fresh(seed?: Record<string, string>): Promise<Volume> {
	const vol = volume(memStorage())
	for (const [path, body] of Object.entries(seed ?? {})) {
		const parent = path.replace(/\/[^/]*$/, '')
		if (parent) await vol.mkdir(parent, { recursive: true })
		await vol.writeFile(path, enc(body))
	}
	return vol
}

describe('createJustBashTool', () => {
	test('runs unix commands over the shared volume, and writes persist back', async () => {
		const vol = await fresh({ '/work/a.txt': 'hello\n' })
		const tool = createJustBashTool({ volume: vol, cwd: '/work' })

		const cat = await tool.execute('1', { command: 'cat a.txt' })
		expect(textOf(cat)).toBe('hello\n')
		expect(cat.details).toMatchObject({ exitCode: 0, truncated: false })

		await tool.execute('2', { command: 'echo hi > b.txt' })
		expect(new TextDecoder().decode(await vol.readFile('/work/b.txt'))).toBe('hi\n')
	})

	test('the same Bash instance persists state between calls', async () => {
		const tool = createJustBashTool({ volume: await fresh() })
		await tool.execute('1', { command: 'echo persisted > /f' })
		expect(textOf(await tool.execute('2', { command: 'cat /f' }))).toBe('persisted\n')
	})

	test('pipes and globs compose', async () => {
		const vol = await fresh({ '/x': 'c\na\nb\n' })
		const tool = createJustBashTool({ volume: vol })
		expect(textOf(await tool.execute('1', { command: 'cat /x | sort' }))).toBe('a\nb\nc\n')
	})

	test('a custom command is registered and surfaced in the description', async () => {
		const hi: ShellCommand = {
			name: 'hi',
			summary: 'greet someone',
			execute: async (args) => ({ stdout: `hi ${args[0] ?? 'world'}\n`, stderr: '', exitCode: 0 })
		}
		const tool = createJustBashTool({ volume: await fresh(), commands: [hi] })
		expect(tool.description).toContain('hi: greet someone')
		expect(textOf(await tool.execute('1', { command: 'hi alice' }))).toBe('hi alice\n')
	})

	test('disable removes a built-in', async () => {
		const vol = await fresh({ '/f': 'data' })
		const tool = createJustBashTool({ volume: vol, disable: ['cat'] })
		const r = await tool.execute('1', { command: 'cat /f' })
		expect(r.details).not.toMatchObject({ exitCode: 0 })
	})

	test('a non-zero exit code is surfaced in both text and details', async () => {
		const tool = createJustBashTool({ volume: await fresh() })
		const r = await tool.execute('1', { command: 'cat /nope' })
		expect(textOf(r)).toContain('exit code')
		expect((r.details as { exitCode: number }).exitCode).not.toBe(0)
	})

	test('env is seeded into the shell', async () => {
		const tool = createJustBashTool({ volume: await fresh(), env: { GREETING: 'yo' } })
		expect(textOf(await tool.execute('1', { command: 'echo "$GREETING"' }))).toBe('yo\n')
	})
})

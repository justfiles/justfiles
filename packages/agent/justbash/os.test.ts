import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { describe, expect, test } from 'vitest'
import { createJustBashTool } from './index.ts'
import { createOsCommand, type OsWindowInfo } from './os.ts'

function shell(windows: readonly OsWindowInfo[]) {
	const tool = createJustBashTool({
		volume: volume(memStorage()),
		commands: [createOsCommand(async () => ({ windows }))]
	})
	return async (command: string) => {
		const result = await tool.execute('1', { command }, new AbortController().signal)
		return {
			text: result.content.map((c) => ('text' in c ? c.text : '')).join(''),
			exitCode: (result.details as { exitCode: number }).exitCode
		}
	}
}

describe('os windows', () => {
	test('lists the windows, marking the focused one', async () => {
		const run = shell([
			{ appId: 'justfiles.notes', title: 'Notes — groceries', focused: true },
			{ appId: 'justfiles.pixel', title: 'Pixel', focused: false },
			{ title: 'Chat', focused: false, minimized: true }
		])
		const { text, exitCode } = await run('os windows')
		expect(exitCode).toBe(0)
		expect(text).toBe(
			[
				'* justfiles.notes Notes — groceries',
				'  justfiles.pixel Pixel',
				'  -               Chat (minimized)'
			].join('\n')
		)
	})

	test('pipes like any shell command', async () => {
		const run = shell([
			{ appId: 'app.a', focused: true },
			{ appId: 'app.b', focused: false }
		])
		expect((await run("os windows | grep '^\\*' | awk '{print $2}'")).text).toBe('app.a\n')
	})

	test('says so when nothing is open', async () => {
		expect((await shell([])('os windows')).text).toBe('no windows open')
	})

	test('prints help for `os`, and fails on an unknown subcommand', async () => {
		const run = shell([])
		expect(await run('os')).toEqual({ text: 'usage: os windows', exitCode: 0 })
		const unknown = await run('os focus')
		expect(unknown.exitCode).toBe(1)
		expect(unknown.text).toContain('usage: os windows')
	})
})

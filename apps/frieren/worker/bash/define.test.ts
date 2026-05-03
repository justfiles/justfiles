import { describe, expect, test } from 'bun:test'
import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { defineCommand, parseArgs, renderHelp, UsageError } from './define.ts'
import { createBashTool } from './index.ts'
import { type CommandContext, CommandRegistry } from './registry.ts'

function makeCtx(): CommandContext {
	return { vol: volume(memStorage()) }
}

const greetSpec = {
	name: 'greet',
	summary: 'Greet someone',
	args: [
		{ name: 'who', required: true, description: 'Person to greet' },
		{ name: 'mood', description: 'Optional mood' }
	],
	flags: [{ name: 'loud', short: 'l', description: 'Shout the greeting' }],
	async run() {
		return { stdout: '', stderr: '', exitCode: 0 }
	}
} as const

describe('parseArgs', () => {
	test('happy path: positional + flag interleaved', () => {
		const parsed = parseArgs(greetSpec, ['alice', '--loud', 'happy'])
		expect(parsed.args.who).toBe('alice')
		expect(parsed.args.mood).toBe('happy')
		expect(parsed.flags.loud).toBe(true)
	})

	test('short flag is recognized', () => {
		const parsed = parseArgs(greetSpec, ['-l', 'alice'])
		expect(parsed.flags.loud).toBe(true)
		expect(parsed.args.who).toBe('alice')
	})

	test('flags default to false when absent', () => {
		const parsed = parseArgs(greetSpec, ['alice'])
		expect(parsed.flags.loud).toBe(false)
		expect(parsed.args.mood).toBeUndefined()
	})

	test('missing required arg throws UsageError with usage', () => {
		expect(() => parseArgs(greetSpec, [])).toThrow(UsageError)
		try {
			parseArgs(greetSpec, [])
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			expect(message).toContain('who')
			expect(message).toContain('usage:')
		}
	})

	test('unknown long flag throws UsageError with usage', () => {
		try {
			parseArgs(greetSpec, ['alice', '--bogus'])
			expect.unreachable()
		} catch (error) {
			expect(error).toBeInstanceOf(UsageError)
			const message = error instanceof Error ? error.message : String(error)
			expect(message).toContain('--bogus')
			expect(message).toContain('usage:')
		}
	})

	test('unknown short flag throws UsageError', () => {
		expect(() => parseArgs(greetSpec, ['alice', '-x'])).toThrow(UsageError)
	})

	test('extra positional throws UsageError', () => {
		expect(() => parseArgs(greetSpec, ['alice', 'happy', 'extra'])).toThrow(UsageError)
	})
})

describe('renderHelp', () => {
	test('includes name, summary, usage, args, and flags', () => {
		const help = renderHelp(greetSpec)
		expect(help).toContain('greet')
		expect(help).toContain('Greet someone')
		expect(help).toContain('usage:')
		expect(help).toContain('<who>')
		expect(help).toContain('[mood]')
		expect(help).toContain('--loud')
		expect(help).toContain('-l')
		expect(help).toContain('Person to greet')
	})

	test('omits args/flags sections when none declared', () => {
		const help = renderHelp({
			name: 'ping',
			summary: 'No args',
			async run() {
				return { stdout: '', stderr: '', exitCode: 0 }
			}
		})
		expect(help).toContain('ping')
		expect(help).not.toContain('Arguments:')
		expect(help).not.toContain('Flags:')
	})
})

describe('defineCommand', () => {
	test('--help short-circuits and returns rendered help', async () => {
		const cmd = defineCommand(greetSpec)
		const result = await cmd.run(['--help'], makeCtx())
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('greet')
		expect(result.stdout).toContain('usage:')
	})

	test('-h short-circuits and returns rendered help', async () => {
		const cmd = defineCommand(greetSpec)
		const result = await cmd.run(['-h'], makeCtx())
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('usage:')
	})

	test('passes parsed args + flags to run()', async () => {
		const seen: { args?: Record<string, string | undefined>; flags?: Record<string, boolean> } = {}
		const cmd = defineCommand({
			name: 'capture',
			summary: 'capture',
			args: [{ name: 'first', required: true }],
			flags: [{ name: 'verbose' }],
			async run(parsed) {
				seen.args = parsed.args
				seen.flags = parsed.flags
				return { stdout: 'ok', stderr: '', exitCode: 0 }
			}
		})
		const result = await cmd.run(['hello', '--verbose'], makeCtx())
		expect(result).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 })
		expect(seen.args?.first).toBe('hello')
		expect(seen.flags?.verbose).toBe(true)
	})

	test('parse error becomes exitCode 2 with stderr', async () => {
		const cmd = defineCommand(greetSpec)
		const result = await cmd.run([], makeCtx())
		expect(result.exitCode).toBe(2)
		expect(result.stderr).toContain('who')
	})

	test('output of defineCommand has Command shape (name, summary, run)', () => {
		const cmd = defineCommand(greetSpec)
		expect(cmd.name).toBe('greet')
		expect(cmd.summary).toBe('Greet someone')
		expect(typeof cmd.run).toBe('function')
	})

	test('end-to-end: registers and dispatches via bash tool', async () => {
		const registry = new CommandRegistry()
		registry.register(
			defineCommand({
				name: 'shout',
				summary: 'Shout text',
				args: [{ name: 'text', required: true }],
				flags: [{ name: 'bang' }],
				async run({ args, flags }) {
					return {
						stdout: flags.bang ? `${args.text}!` : args.text,
						stderr: '',
						exitCode: 0
					}
				}
			})
		)
		const tool = createBashTool(registry, makeCtx())
		const ok = await tool.execute('id', { command: 'shout hello --bang' })
		const text = ok.content
			.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
			.map((c) => c.text)
			.join('')
		expect(text).toBe('hello!')

		const help = await tool.execute('id', { command: 'shout --help' })
		const helpText = help.content
			.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
			.map((c) => c.text)
			.join('')
		expect(helpText).toContain('usage:')
		expect(helpText).toContain('shout')
	})
})

import { describe, expect, test } from 'bun:test'
import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { createBashTool } from './index.ts'
import { type Command, type CommandContext, CommandRegistry } from './registry.ts'
import { MAX_OUTPUT_BYTES } from './truncate.ts'

function makeCtx(): CommandContext {
	return { vol: volume(memStorage()) }
}

function echo(): Command {
	return {
		name: 'echo',
		summary: 'Echo args',
		async run(argv) {
			return { stdout: argv.join(' '), stderr: '', exitCode: 0 }
		}
	}
}

function thrower(): Command {
	return {
		name: 'fail',
		summary: 'Always fails',
		async run() {
			throw new Error('boom')
		}
	}
}

function bigOutput(): Command {
	return {
		name: 'big',
		summary: 'Emits a lot',
		async run() {
			return { stdout: 'x'.repeat(MAX_OUTPUT_BYTES + 1000), stderr: '', exitCode: 0 }
		}
	}
}

async function invoke(tool: ReturnType<typeof createBashTool>, command: string) {
	const result = await tool.execute('call-1', { command })
	const text = result.content
		.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
		.map((c) => c.text)
		.join('')
	return { result, text }
}

describe('createBashTool', () => {
	test('dispatches argv[0] to the registered command', async () => {
		const registry = new CommandRegistry()
		registry.register(echo())
		const tool = createBashTool(registry, makeCtx())
		const { result, text } = await invoke(tool, 'echo hi there')
		expect(text).toBe('hi there')
		expect(result.details).toMatchObject({ exitCode: 0 })
	})

	test('unknown command yields exit 127 and lists available commands', async () => {
		const registry = new CommandRegistry()
		registry.register(echo())
		const tool = createBashTool(registry, makeCtx())
		const { result, text } = await invoke(tool, 'bogus arg')
		expect(result.details).toMatchObject({ exitCode: 127 })
		expect(text).toContain('not found')
		expect(text).toContain('echo')
	})

	test('handler that throws yields exit 1 and surfaces the error message', async () => {
		const registry = new CommandRegistry()
		registry.register(thrower())
		const tool = createBashTool(registry, makeCtx())
		const { result, text } = await invoke(tool, 'fail')
		expect(result.details).toMatchObject({ exitCode: 1 })
		expect(text).toContain('boom')
		expect(text).not.toContain('at ')
	})

	test('truncates large output with a marker', async () => {
		const registry = new CommandRegistry()
		registry.register(bigOutput())
		const tool = createBashTool(registry, makeCtx())
		const { text } = await invoke(tool, 'big')
		expect(text).toContain('[truncated:')
		expect(text).toContain('bytes dropped')
	})

	test('empty command yields exit 127 with not-found-style message', async () => {
		const registry = new CommandRegistry()
		const tool = createBashTool(registry, makeCtx())
		const { result } = await invoke(tool, '   ')
		expect(result.details).toMatchObject({ exitCode: 127 })
	})

	test('description summarises the registered commands', () => {
		const registry = new CommandRegistry()
		registry.register(echo())
		const tool = createBashTool(registry, makeCtx())
		expect(tool.description).toContain('echo')
	})

	test('description updates after register/unregister', () => {
		const registry = new CommandRegistry()
		const tool = createBashTool(registry, makeCtx())
		expect(tool.description).not.toContain('echo')
		registry.register(echo())
		expect(tool.description).toContain('echo')
		registry.unregister('echo')
		expect(tool.description).not.toContain('echo')
	})
})

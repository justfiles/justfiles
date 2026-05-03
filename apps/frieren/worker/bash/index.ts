import type { AgentTool } from '@mariozechner/pi-agent-core'
import Type from 'typebox'
import { ParseError, parse } from './parser.ts'
import type { CommandContext, CommandRegistry, CommandResult } from './registry.ts'
import { truncateTail } from './truncate.ts'

const bashParams = Type.Object({
	command: Type.String({ description: 'The full command line to run, including arguments.' })
})

export function createBashTool(
	registry: CommandRegistry,
	ctx: CommandContext
): AgentTool<typeof bashParams> {
	return {
		name: 'bash',
		label: 'Bash',
		parameters: bashParams,
		get description() {
			return describe(registry)
		},
		async execute(_toolCallId, params) {
			const result = await dispatch(registry, ctx, params.command)
			return formatResult(result)
		}
	}
}

async function dispatch(
	registry: CommandRegistry,
	ctx: CommandContext,
	commandLine: string
): Promise<CommandResult> {
	let argv: string[]
	try {
		argv = parse(commandLine)
	} catch (error) {
		const message = error instanceof ParseError ? error.message : String(error)
		return { stdout: '', stderr: `parse error: ${message}`, exitCode: 2 }
	}
	if (argv.length === 0) {
		return { stdout: '', stderr: notFoundMessage(registry, ''), exitCode: 127 }
	}
	const [name, ...rest] = argv
	const command = registry.lookup(name)
	if (!command) {
		return { stdout: '', stderr: notFoundMessage(registry, name), exitCode: 127 }
	}
	try {
		return await command.run(rest, ctx)
	} catch (error) {
		return {
			stdout: '',
			stderr: error instanceof Error ? error.message : String(error),
			exitCode: 1
		}
	}
}

function notFoundMessage(registry: CommandRegistry, name: string): string {
	const subject = name ? `${name}: command not found` : 'command not found'
	const list = registry.list()
	if (list.length === 0) return `${subject}\nNo commands available.`
	const lines = list.map((c) => `  ${c.name}\t${c.summary}`).join('\n')
	return `${subject}\nAvailable commands:\n${lines}`
}

function describe(registry: CommandRegistry): string {
	const list = registry.list()
	const intro = 'Run a registered command. Use "<name> --help" to see usage for a specific command.'
	if (list.length === 0) return `${intro}\n\nNo commands are currently registered.`
	const lines = list.map((c) => `- ${c.name}: ${c.summary}`).join('\n')
	return `${intro}\n\nAvailable commands:\n${lines}`
}

function formatResult(result: CommandResult) {
	const parts: string[] = []
	if (result.stdout) parts.push(result.stdout)
	if (result.stderr) parts.push(result.stderr)
	const merged = parts.join(parts.length > 1 ? '\n' : '') || '(no output)'
	const truncated = truncateTail(merged)
	const text =
		result.exitCode === 0 ? truncated.text : `${truncated.text}\n[exit code ${result.exitCode}]`
	return {
		content: [{ type: 'text' as const, text }],
		details: {
			exitCode: result.exitCode,
			truncated: truncated.truncated,
			droppedBytes: truncated.droppedBytes
		}
	}
}

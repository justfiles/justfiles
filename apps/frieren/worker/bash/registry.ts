import type { Volume } from '@justfiles/fs'

export interface CommandContext {
	vol: Volume
}

export interface CommandResult {
	stdout: string
	stderr: string
	exitCode: number
}

export interface Command {
	name: string
	summary: string
	run: (argv: string[], ctx: CommandContext) => Promise<CommandResult>
}

export interface CommandSummary {
	name: string
	summary: string
}

export class CommandRegistry {
	private readonly commands = new Map<string, Command>()

	register(command: Command): void {
		if (this.commands.has(command.name)) {
			throw new Error(`Command ${command.name} is already registered`)
		}
		this.commands.set(command.name, command)
	}

	unregister(name: string): void {
		this.commands.delete(name)
	}

	lookup(name: string): Command | undefined {
		return this.commands.get(name)
	}

	list(): CommandSummary[] {
		return [...this.commands.values()]
			.map(({ name, summary }) => ({ name, summary }))
			.sort((a, b) => a.name.localeCompare(b.name))
	}
}

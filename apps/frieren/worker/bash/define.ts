import type { Command, CommandContext, CommandResult } from './registry.ts'

export interface ArgSpec {
	readonly name: string
	readonly required?: boolean
	readonly description?: string
}

export interface FlagSpec {
	readonly name: string
	readonly short?: string
	readonly description?: string
}

type RequiredNames<A extends readonly ArgSpec[]> = {
	[K in keyof A]: A[K] extends { required: true } ? A[K]['name'] : never
}[number]

type OptionalNames<A extends readonly ArgSpec[]> = {
	[K in keyof A]: A[K] extends { required: true } ? never : A[K]['name']
}[number]

export type ParsedArgs<A extends readonly ArgSpec[]> = { [K in RequiredNames<A>]: string } & {
	[K in OptionalNames<A>]?: string
}

export type ParsedFlags<F extends readonly FlagSpec[]> = { [K in F[number]['name']]: boolean }

export interface CommandSpec<
	A extends readonly ArgSpec[] = readonly ArgSpec[],
	F extends readonly FlagSpec[] = readonly FlagSpec[]
> {
	name: string
	summary: string
	args?: A
	flags?: F
	run: (
		parsed: { args: ParsedArgs<A>; flags: ParsedFlags<F> },
		ctx: CommandContext
	) => Promise<CommandResult> | CommandResult
}

export class UsageError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'UsageError'
	}
}

export function parseArgs<A extends readonly ArgSpec[], F extends readonly FlagSpec[]>(
	spec: CommandSpec<A, F>,
	argv: string[]
): { args: ParsedArgs<A>; flags: ParsedFlags<F> } {
	const argSpecs = spec.args ?? []
	const flagSpecs = spec.flags ?? []
	const args: Record<string, string> = {}
	const flags: Record<string, boolean> = {}
	for (const f of flagSpecs) flags[f.name] = false

	const positionals: string[] = []
	for (const token of argv) {
		if (token.startsWith('--')) {
			const name = token.slice(2)
			const flag = flagSpecs.find((f) => f.name === name)
			if (!flag) throw new UsageError(`unknown flag: --${name}\n${renderUsage(spec)}`)
			flags[flag.name] = true
		} else if (token.startsWith('-') && token.length > 1) {
			const short = token.slice(1)
			const flag = flagSpecs.find((f) => f.short === short)
			if (!flag) throw new UsageError(`unknown flag: -${short}\n${renderUsage(spec)}`)
			flags[flag.name] = true
		} else {
			positionals.push(token)
		}
	}

	for (let i = 0; i < argSpecs.length; i++) {
		const argSpec = argSpecs[i]
		const value = positionals[i]
		if (value === undefined) {
			if (argSpec.required) {
				throw new UsageError(`missing required argument: ${argSpec.name}\n${renderUsage(spec)}`)
			}
		} else {
			args[argSpec.name] = value
		}
	}

	if (positionals.length > argSpecs.length) {
		throw new UsageError(
			`unexpected argument: ${positionals[argSpecs.length]}\n${renderUsage(spec)}`
		)
	}

	return { args: args as ParsedArgs<A>, flags: flags as ParsedFlags<F> }
}

function renderUsage(spec: CommandSpec): string {
	const argParts = (spec.args ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
	const flagPart = (spec.flags ?? []).length > 0 ? ' [flags]' : ''
	const argPart = argParts.length > 0 ? ` ${argParts.join(' ')}` : ''
	return `usage: ${spec.name}${flagPart}${argPart}`
}

export function renderHelp(spec: CommandSpec): string {
	const lines: string[] = [`${spec.name} — ${spec.summary}`, '', renderUsage(spec)]
	const args = spec.args ?? []
	if (args.length > 0) {
		lines.push('', 'Arguments:')
		for (const a of args) {
			const tag = a.required ? '' : ' (optional)'
			const desc = a.description ? `  ${a.description}` : ''
			lines.push(`  ${a.name}${tag}${desc}`)
		}
	}
	const flags = spec.flags ?? []
	if (flags.length > 0) {
		lines.push('', 'Flags:')
		for (const f of flags) {
			const labels = [f.short ? `-${f.short}` : null, `--${f.name}`].filter(Boolean).join(', ')
			const desc = f.description ? `  ${f.description}` : ''
			lines.push(`  ${labels}${desc}`)
		}
	}
	return lines.join('\n')
}

export function defineCommand<A extends readonly ArgSpec[], F extends readonly FlagSpec[]>(
	spec: CommandSpec<A, F>
): Command {
	return {
		name: spec.name,
		summary: spec.summary,
		async run(argv, ctx) {
			if (argv.includes('--help') || argv.includes('-h')) {
				return { stdout: renderHelp(spec), stderr: '', exitCode: 0 }
			}
			let parsed: { args: ParsedArgs<A>; flags: ParsedFlags<F> }
			try {
				parsed = parseArgs(spec, argv)
			} catch (error) {
				if (error instanceof UsageError) {
					return { stdout: '', stderr: error.message, exitCode: 2 }
				}
				throw error
			}
			return await spec.run(parsed, ctx)
		}
	}
}

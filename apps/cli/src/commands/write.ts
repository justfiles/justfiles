import { Buffer } from 'node:buffer'
import { CliUsageError } from '../errors.ts'
import { normalizeVolumePath, parentVolumePath } from '../paths.ts'
import { out, info, printJson, readStdin } from '../output.ts'
import type { CommandContext, CommandModule } from '../command.ts'
import { parseCommandArgs } from '../args.ts'

const help = `\
Usage: files write [options] <path> [content]

Write a file. Content can be passed as an argument or piped through stdin.

Arguments:
  <path>             Absolute path to write
  [content]          Text content when not using --stdin

Options:
  --stdin            Read content from stdin
  --append           Append instead of overwrite
  --parents          Create missing parent directories before writing
  -h, --help         Show this help

Global options:
  --volume <name>    Select a configured volume
  --config <path>    Load a specific JS config module
  --json             Output as JSON

Exit codes:
  0  Success
  1  Backend or runtime error
  2  Parent directory not found
  3  Conflict
  4  Missing or invalid argument

Examples:
  files write /notes/today.md "hello world"
  printf 'hello\\n' | files write --stdin /notes/today.md
  files write --append /notes/log.txt "another line"
  files write --parents /notes/daily/2026-04-08.md "entry"`

async function run(args: string[], context: CommandContext): Promise<void> {
	const { values, positionals } = parseCommandArgs({
		args,
		options: {
			stdin: { type: 'boolean' },
			append: { type: 'boolean' },
			parents: { type: 'boolean' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	}, help)

	if (values.help) {
		out(help)
		return
	}

	if (positionals.length === 0) {
		throw new CliUsageError('write requires a <path> argument', help)
	}

	const path = normalizeVolumePath(positionals[0]!)
	const contentArg = positionals.slice(1).join(' ')

	if (values.stdin && contentArg) {
		throw new CliUsageError('pass content either via [content] or --stdin, not both', help)
	}

	let content: string | null = null
	if (values.stdin) {
		content = await readStdin()
	} else if (contentArg) {
		content = contentArg
	} else if (!process.stdin.isTTY) {
		content = await readStdin()
	}

	if (content === null) {
		throw new CliUsageError('content is required — pass [content] or pipe stdin', help)
	}

	if (values.parents) {
		await context.volume.mkdir(parentVolumePath(path), { recursive: true })
	}

	const bytes = Buffer.from(content, 'utf8')
	if (values.append) {
		await context.volume.appendFile(path, bytes)
	} else {
		await context.volume.writeFile(path, bytes)
	}

	if (context.json) {
		printJson({
			ok: true,
			volume: context.volumeName,
			path,
			mode: values.append ? 'append' : 'write',
			bytes: bytes.length,
		})
		return
	}

	info(`Wrote ${path}.`, context.quiet)
}

export default { help, run } satisfies CommandModule

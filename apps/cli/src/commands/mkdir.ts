import { parseCommandArgs } from '../args.ts'
import type { CommandContext, CommandModule } from '../command.ts'
import { CliUsageError } from '../errors.ts'
import { info, out, printJson } from '../output.ts'
import { normalizeVolumePath } from '../paths.ts'

const help = `\
Usage: files mkdir [options] <path>

Create a directory.

Arguments:
  <path>            Absolute directory path

Options:
  -p, --parents     Create missing parents and succeed if the directory exists
  -h, --help        Show this help

Global options:
  --volume <name>   Select a configured volume
  --config <path>   Load a specific JS config module
  --json            Output as JSON

Exit codes:
  0  Success
  1  Backend or runtime error
  2  Parent directory not found
  3  Conflict
  4  Missing or invalid argument

Examples:
  files mkdir /notes
  files mkdir -p /notes/daily/2026`

async function run(args: string[], context: CommandContext): Promise<void> {
	const { values, positionals } = parseCommandArgs(
		{
			args,
			options: {
				parents: { type: 'boolean', short: 'p' },
				help: { type: 'boolean', short: 'h' }
			},
			allowPositionals: true
		},
		help
	)

	if (values.help) {
		out(help)
		return
	}

	if (positionals.length !== 1) {
		throw new CliUsageError('mkdir requires exactly one <path> argument', help)
	}

	const path = normalizeVolumePath(positionals[0]!)
	const recursive = Boolean(values.parents)
	await context.volume.mkdir(path, recursive ? { recursive: true } : undefined)

	if (context.json) {
		printJson({ ok: true, volume: context.volumeName, path, recursive })
		return
	}

	info(`Created ${path}.`, context.quiet)
}

export default { help, run } satisfies CommandModule

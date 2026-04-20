import { parseCommandArgs } from '../args.ts'
import type { CommandContext, CommandModule } from '../command.ts'
import { CliUsageError } from '../errors.ts'
import { info, out, printJson } from '../output.ts'
import { normalizeVolumePath } from '../paths.ts'

const help = `\
Usage: files mv <source> <destination>

Move or rename a file or directory.

Arguments:
  <source>       Absolute source path
  <destination>  Absolute destination path

Global options:
  --volume <name>  Select a configured volume
  --config <path>  Load a specific JS config module
  --json           Output as JSON
  -h, --help       Show this help

Exit codes:
  0  Success
  1  Backend or runtime error
  2  Source not found
  3  Conflict
  4  Missing or invalid argument

Examples:
  files mv /notes/today.md /notes/yesterday.md
  files mv /notes/inbox /notes/archive`

async function run(args: string[], context: CommandContext): Promise<void> {
	const { values, positionals } = parseCommandArgs(
		{
			args,
			options: {
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

	if (positionals.length !== 2) {
		throw new CliUsageError('mv requires <source> and <destination>', help)
	}

	const source = normalizeVolumePath(positionals[0]!)
	const destination = normalizeVolumePath(positionals[1]!)
	await context.volume.rename(source, destination)

	if (context.json) {
		printJson({ ok: true, volume: context.volumeName, source, destination })
		return
	}

	info(`Moved ${source} to ${destination}.`, context.quiet)
}

export default { help, run } satisfies CommandModule

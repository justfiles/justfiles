import { CliUsageError } from '../errors.ts'
import { normalizeVolumePath } from '../paths.ts'
import { out, info, printJson } from '../output.ts'
import type { CommandContext, CommandModule } from '../command.ts'
import { parseCommandArgs } from '../args.ts'

const help = `\
Usage: files cp [options] <source> <destination>

Copy a file or directory.

Arguments:
  <source>       Absolute source path
  <destination>  Absolute destination path

Options:
  -r, --recursive  Required when copying a directory
  -h, --help       Show this help

Global options:
  --volume <name>  Select a configured volume
  --config <path>  Load a specific JS config module
  --json           Output as JSON

Exit codes:
  0  Success
  1  Backend or runtime error
  2  Source not found
  3  Conflict
  4  Missing or invalid argument

Examples:
  files cp /notes/today.md /backup/today.md
  files cp -r /notes/archive /backup/archive`

async function run(args: string[], context: CommandContext): Promise<void> {
	const { values, positionals } = parseCommandArgs({
		args,
		options: {
			recursive: { type: 'boolean', short: 'r' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	}, help)

	if (values.help) {
		out(help)
		return
	}

	if (positionals.length !== 2) {
		throw new CliUsageError('cp requires <source> and <destination>', help)
	}

	const source = normalizeVolumePath(positionals[0]!)
	const destination = normalizeVolumePath(positionals[1]!)
	const recursive = Boolean(values.recursive)

	await context.volume.cp(source, destination, recursive ? { recursive: true } : undefined)

	if (context.json) {
		printJson({ ok: true, volume: context.volumeName, source, destination, recursive })
		return
	}

	info(`Copied ${source} to ${destination}.`, context.quiet)
}

export default { help, run } satisfies CommandModule

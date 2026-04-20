import { parseCommandArgs } from '../args.ts'
import type { CommandContext, CommandModule } from '../command.ts'
import { CliUsageError } from '../errors.ts'
import { formatStat, statToJson } from '../fs-output.ts'
import { out, printJson } from '../output.ts'
import { normalizeVolumePath } from '../paths.ts'

const help = `\
Usage: files stat <path>

Inspect metadata for a file, directory, or symlink.

Arguments:
  <path>          Absolute path within the selected volume

Global options:
  --volume <name> Select a configured volume
  --config <path> Load a specific JS config module
  --json          Output as JSON
  -h, --help      Show this help

Exit codes:
  0  Success
  1  Backend or runtime error
  2  Path not found
  4  Missing or invalid argument

Examples:
  files stat /notes/today.md
  files stat /notes --json`

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

	if (positionals.length !== 1) {
		throw new CliUsageError('stat requires exactly one <path> argument', help)
	}

	const path = normalizeVolumePath(positionals[0]!)
	const stat = await context.volume.stat(path)

	if (context.json) {
		printJson(statToJson(path, stat))
		return
	}

	for (const line of formatStat(path, stat)) {
		out(line)
	}
}

export default { help, run } satisfies CommandModule

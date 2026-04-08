import { Buffer } from 'node:buffer'
import { CliUsageError } from '../errors.ts'
import { normalizeVolumePath } from '../paths.ts'
import { out, printJson, writeBytes } from '../output.ts'
import type { CommandContext, CommandModule } from '../command.ts'
import { parseCommandArgs } from '../args.ts'

const help = `\
Usage: files cat <path>

Print a file to stdout.

Arguments:
  <path>          Absolute path within the selected volume

Global options:
  --volume <name> Select a configured volume
  --config <path> Load a specific JS config module
  --json          Output as JSON with base64-encoded content
  -h, --help      Show this help

Exit codes:
  0  Success
  1  Backend or runtime error
  2  File not found
  4  Missing or invalid argument

Examples:
  files cat /notes/today.md
  files --volume api cat /notes/today.md
  files cat /notes/logo.png --json`

async function run(args: string[], context: CommandContext): Promise<void> {
	const { values, positionals } = parseCommandArgs({
		args,
		options: {
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	}, help)

	if (values.help) {
		out(help)
		return
	}

	if (positionals.length !== 1) {
		throw new CliUsageError('cat requires exactly one <path> argument', help)
	}

	const path = normalizeVolumePath(positionals[0]!)
	const data = await context.volume.readFile(path)

	if (context.json) {
		printJson({
			volume: context.volumeName,
			path,
			encoding: 'base64',
			data: Buffer.from(data).toString('base64'),
		})
		return
	}

	writeBytes(data)
}

export default { help, run } satisfies CommandModule

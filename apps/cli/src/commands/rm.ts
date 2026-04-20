import { parseCommandArgs } from '../args.ts'
import type { CommandContext, CommandModule } from '../command.ts'
import { CliUsageError } from '../errors.ts'
import { info, out, printJson } from '../output.ts'
import { normalizeVolumePath } from '../paths.ts'

const help = `\
Usage: files rm [options] <path>

Remove a file or directory.

Arguments:
  <path>             Absolute path to remove

Options:
  -r, --recursive    Remove directories recursively
  -f, --force        Succeed if the path does not exist
  -h, --help         Show this help

Global options:
  --volume <name>    Select a configured volume
  --config <path>    Load a specific JS config module
  --json             Output as JSON

Exit codes:
  0  Success
  1  Backend or runtime error
  2  Path not found
  3  Conflict
  4  Missing or invalid argument

Examples:
  files rm /notes/today.md
  files rm -r /notes/archive
  files rm -f /notes/missing.md`

async function run(args: string[], context: CommandContext): Promise<void> {
	const { values, positionals } = parseCommandArgs(
		{
			args,
			options: {
				recursive: { type: 'boolean', short: 'r' },
				force: { type: 'boolean', short: 'f' },
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
		throw new CliUsageError('rm requires exactly one <path> argument', help)
	}

	const path = normalizeVolumePath(positionals[0]!)
	const recursive = Boolean(values.recursive)
	const force = Boolean(values.force)

	await context.volume.rm(path, {
		recursive,
		force
	})

	if (context.json) {
		printJson({ ok: true, volume: context.volumeName, path, recursive, force })
		return
	}

	info(`Removed ${path}.`, context.quiet)
}

export default { help, run } satisfies CommandModule

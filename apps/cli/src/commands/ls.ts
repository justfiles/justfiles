import { FileType } from '@justfiles/fs/types'
import { CliUsageError } from '../errors.ts'
import { formatLongEntry, statToJson } from '../fs-output.ts'
import { basenameVolumePath, joinVolumePath, normalizeVolumePath } from '../paths.ts'
import { out, printJson } from '../output.ts'
import type { CommandContext, CommandModule } from '../command.ts'
import { parseCommandArgs } from '../args.ts'

const help = `\
Usage: files ls [options] [path]

List a directory or inspect a single file.

Arguments:
  [path]           Absolute path within the selected volume [default: /]

Options:
  -l               Long format (type, size, mtime, name)
  -h, --help       Show this help

Global options:
  --volume <name>  Select a configured volume
  --config <path>  Load a specific JS config module
  --json           Output as JSON

Exit codes:
  0  Success
  1  Backend or runtime error
  2  Path not found
  4  Invalid argument

Examples:
  files ls
  files ls /notes
  files ls -l /notes
  files --volume api ls /notes --json`

async function run(args: string[], context: CommandContext): Promise<void> {
	const { values, positionals } = parseCommandArgs({
		args,
		options: {
			l: { type: 'boolean', short: 'l' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	}, help)

	if (values.help) {
		out(help)
		return
	}

	if (positionals.length > 1) {
		throw new CliUsageError('ls accepts at most one [path] argument', help)
	}

	const long = Boolean(values.l)
	const path = normalizeVolumePath(positionals[0] ?? '/')
	const stat = await context.volume.stat(path)

	if (stat.type !== FileType.Directory) {
		if (context.json) {
			printJson([statToJson(path, stat)])
			return
		}
		out(long ? formatLongEntry(basenameVolumePath(path), stat) : basenameVolumePath(path))
		return
	}

	const entries = (await context.volume.readdir(path))
		.slice()
		.sort((left, right) => left.name.localeCompare(right.name))

	if (context.json) {
		if (!long) {
			printJson(entries.map((entry) => ({
				name: entry.name,
				path: joinVolumePath(path, entry.name),
				type: entry.type === FileType.Directory ? 'directory' : entry.type === FileType.Symlink ? 'symlink' : 'file',
				ino: entry.ino,
			})))
			return
		}

		const results = await Promise.all(entries.map(async (entry) => {
			const entryPath = joinVolumePath(path, entry.name)
			return statToJson(entryPath, await context.volume.stat(entryPath))
		}))
		printJson(results)
		return
	}

	if (long) {
		for (const entry of entries) {
			const entryPath = joinVolumePath(path, entry.name)
			out(formatLongEntry(entry.name, await context.volume.stat(entryPath)))
		}
		return
	}

	for (const entry of entries) {
		out(entry.name)
	}
}

export default { help, run } satisfies CommandModule

import { parseArgs } from 'util'
import { loadConfig } from './config.ts'
import { out, printError } from './output.ts'
import * as write from './commands/write.ts'
import * as get from './commands/get.ts'
import * as search from './commands/search.ts'
import * as update from './commands/update.ts'
import * as list from './commands/list.ts'
import * as link from './commands/link.ts'
import * as archive from './commands/archive.ts'

const MAIN_HELP = `\
Usage: ghostore [options] <command> [command-options]

A command-line interface for interacting with the Ghostore memory backend.
Designed to be agent-friendly: all commands support --json output, structured
exit codes, and print usage hints on error.

Commands:
  write    Write a memory (create or update by path)
  get      Fetch a memory by ID or path
  search   Search memories with semantic/full-text/hybrid search
  update   Update an existing memory's metadata or content
  list     List memories by path prefix or tag
  link     Create a directed link between two memories
  archive  Archive a memory (soft-delete, recoverable for 30 days)

Global options:
  --url <url>    Backend URL [env: GHOSTORE_URL] [default: http://localhost:5173]
  --key <key>    API key  [env: GHOSTORE_API_KEY]
  --json         Output all results as JSON
  -q, --quiet    Suppress informational output
  -h, --help     Show this help
  -v, --version  Show version

Exit codes:
  0  Success
  1  API or network error
  2  Not found
  3  Conflict
  4  Missing or invalid argument

Run 'ghostore <command> --help' for command-specific options and examples.`

const commands: Record<string, { help: string; run: (args: string[], cfg: ReturnType<typeof loadConfig>) => Promise<void> }> = {
	write,
	get,
	search,
	update,
	list,
	link,
	archive,
}

async function main() {
	const argv = process.argv.slice(2)

	// Fast path: no args or top-level --help / --version
	if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
		out(MAIN_HELP)
		process.exit(0)
	}
	if (argv[0] === '--version' || argv[0] === '-v') {
		out('0.1.0')
		process.exit(0)
	}

	// Parse global flags (strict: false so we don't error on command-specific flags)
	const { values } = parseArgs({
		args: argv,
		options: {
			url: { type: 'string' },
			key: { type: 'string' },
			json: { type: 'boolean' },
			quiet: { type: 'boolean', short: 'q' },
			help: { type: 'boolean', short: 'h' },
			version: { type: 'boolean', short: 'v' },
		},
		allowPositionals: true,
		strict: false,
	})

	const cfg = loadConfig({
		url: values.url,
		key: values.key,
		json: values.json as boolean | undefined,
		quiet: values.quiet as boolean | undefined,
	})

	// Find the command: first non-flag arg, skipping values of known valued flags
	const valuedFlags = new Set(['--url', '--key'])
	let cmdIndex = -1
	let i = 0
	while (i < argv.length) {
		const arg = argv[i]
		if (valuedFlags.has(arg)) {
			i += 2
		} else if (arg.startsWith('-')) {
			i++
		} else {
			cmdIndex = i
			break
		}
	}

	if (cmdIndex === -1) {
		out(MAIN_HELP)
		process.exit(0)
	}

	const commandName = argv[cmdIndex]
	const commandArgs = argv.slice(cmdIndex + 1)
	const command = commands[commandName]

	if (!command) {
		printError(
			`unknown command: ${commandName}`,
			`Run 'ghostore --help' to see available commands.`,
		)
		process.exit(4)
	}

	await command.run(commandArgs, cfg)
}

main().catch((e) => {
	printError(e instanceof Error ? e.message : String(e))
	process.exit(1)
})

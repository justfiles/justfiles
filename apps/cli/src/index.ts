import { parseArgs } from 'node:util'
import { loadConfig } from './config.ts'
import { CliUsageError, errorMessage, exitCodeForError, getErrno } from './errors.ts'
import { out, printError, printJsonError } from './output.ts'
import type { CommandModule } from './command.ts'
import { loadVolume } from './volumes.ts'
import ls from './commands/ls.ts'
import cat from './commands/cat.ts'
import write from './commands/write.ts'
import mkdir from './commands/mkdir.ts'
import rm from './commands/rm.ts'
import mv from './commands/mv.ts'
import cp from './commands/cp.ts'
import stat from './commands/stat.ts'

const MAIN_HELP = `\
Usage: files [options] <command> [command-options]

A command-line interface for interacting with Just Files volumes.
Designed to be agent-friendly: all commands have focused help, structured
exit codes, and usage-rich errors.

Commands:
  ls       List a directory or inspect a single file
  cat      Print a file to stdout
  write    Write or append a file
  mkdir    Create a directory
  rm       Remove a file or directory
  mv       Move or rename a file or directory
  cp       Copy a file or directory
  stat     Inspect metadata for a path

Global options:
  --config <path>   Load a specific JS config module
  --volume <name>   Select a configured volume [env: FILES_VOLUME]
  --json            Output command results as JSON when supported
  -q, --quiet       Suppress informational stderr output
  -h, --help        Show this help
  -v, --version     Show version

Configuration:
  The CLI loads the first config file it finds from:
    ./files.config.js
    ./files.config.mjs
    ./files.config.cjs
    ~/.config/files/config.js
    ~/.files/config.js

  Example files.config.js:
    export default {
      defaultVolume: 'work',
      volumes: {
        local: './notes',
        work: {
          type: 'remote',
          token: process.env.JUSTFILES_TOKEN
        },
        localDev: {
          type: 'remote',
          token: process.env.JUSTFILES_TOKEN,
          url: 'http://localhost:5173'
        }
      }
    }

  Volume values can be:
    '/some/path' or './relative/path'  Local filesystem shortcut
    { type: 'remote', token, url? }    Built-in backend-backed volume
    a Volume instance                  Fully custom JS-defined volume
    a function returning a Volume      Lazy custom volume

  Local volume roots are resolved relative to the config file directory.
  Remote volumes default to https://justfiles.app and mount /fs automatically.

Exit codes:
  0  Success
  1  Backend or runtime error
  2  Not found
  3  Conflict
  4  Missing or invalid argument

Run 'files <command> --help' for command-specific options and examples.`

const commands: Record<string, CommandModule> = {
	ls,
	cat,
	write,
	mkdir,
	rm,
	mv,
	cp,
	stat,
}

const GLOBAL_VALUED_FLAGS = new Set(['--config', '--volume'])
const GLOBAL_BOOLEAN_FLAGS = new Set(['--json', '--quiet', '-q'])

function stripGlobalArgs(args: string[]): string[] {
	const result: string[] = []

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!
		if (GLOBAL_VALUED_FLAGS.has(arg)) {
			index += 1
			continue
		}
		if (GLOBAL_BOOLEAN_FLAGS.has(arg)) continue
		result.push(arg)
	}

	return result
}

function findCommandIndex(argv: string[]): number {
	let index = 0

	while (index < argv.length) {
		const arg = argv[index]!
		if (GLOBAL_VALUED_FLAGS.has(arg)) {
			if (index + 1 >= argv.length) {
				throw new CliUsageError(`option requires a value: ${arg}`, MAIN_HELP)
			}
			index += 2
			continue
		}
		if (GLOBAL_BOOLEAN_FLAGS.has(arg) || arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v') {
			index += 1
			continue
		}
		if (arg.startsWith('-')) {
			throw new CliUsageError(`unknown global option: ${arg}`, MAIN_HELP)
		}
		return index
	}

	return -1
}

function printCaughtError(error: unknown, json: boolean): never {
	const message = errorMessage(error)
	if (json) {
		printJsonError({
			error: message,
			code: getErrno(error) ?? (error instanceof CliUsageError ? 'usage' : 'runtime_error'),
			usage: error instanceof CliUsageError ? error.help : undefined,
		})
	} else {
		printError(message, error instanceof CliUsageError ? error.help : undefined)
	}
	process.exit(exitCodeForError(error))
}

async function main() {
	const argv = process.argv.slice(2)

	if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
		out(MAIN_HELP)
		process.exit(0)
	}
	if (argv[0] === '--version' || argv[0] === '-v') {
		out('0.3.4')
		process.exit(0)
	}

	const { values } = parseArgs({
		args: argv,
		options: {
			config: { type: 'string' },
			volume: { type: 'string' },
			json: { type: 'boolean' },
			quiet: { type: 'boolean', short: 'q' },
			help: { type: 'boolean', short: 'h' },
			version: { type: 'boolean', short: 'v' },
		},
		allowPositionals: true,
		strict: false,
	})

	try {
		const commandIndex = findCommandIndex(argv)
		if (commandIndex === -1) {
			out(MAIN_HELP)
			process.exit(0)
		}

		const commandName = argv[commandIndex]!
		const command = commands[commandName]
		if (!command) {
			throw new CliUsageError(`unknown command: ${commandName}`, `Run 'files --help' to see available commands.`)
		}

		const config = await loadConfig({
			config: values.config,
			volume: values.volume,
			json: values.json as boolean | undefined,
			quiet: values.quiet as boolean | undefined,
		})
		const { volumeName, volume } = await loadVolume(config)

		await command.run(stripGlobalArgs(argv.slice(commandIndex + 1)), {
			volume,
			volumeName,
			json: config.json,
			quiet: config.quiet,
		})
	} catch (error) {
		printCaughtError(error, Boolean(values.json))
	}
}

main().catch((error) => {
	printCaughtError(error, false)
})

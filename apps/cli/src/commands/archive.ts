import { parseArgs } from 'util'
import type { Config } from '../config.ts'
import { makeClient } from '../client.ts'
import { out, info, printError, printJson } from '../output.ts'

export const help = `\
Usage: ghostore archive [options] <id> [id...]

Archive one or more memories. Archived memories are hidden from normal views
and search but remain recoverable for 30 days before permanent deletion.

Arguments:
  <id> [id...]    One or more memory IDs to archive

Options:
  --json          Output as JSON: [{"archived":true,"id":"mem_..."},...]
  -q, --quiet     Suppress output
  -h, --help      Show this help

Exit codes:
  0  Success
  1  API or network error
  2  One or more memories not found
  4  Missing required argument

Examples:
  ghostore archive mem_abc123
  ghostore archive mem_abc123 mem_def456 mem_ghi789
  ghostore archive mem_abc123 --json`

export async function run(args: string[], cfg: Config): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			json: { type: 'boolean' },
			quiet: { type: 'boolean', short: 'q' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
		strict: false,
	})

	if (values.help) {
		out(help)
		return
	}

	if (positionals.length === 0) {
		printError('at least one <id> is required', help)
		process.exit(4)
	}

	const useJson = (values.json as boolean | undefined) ?? cfg.json
	const quiet = (values.quiet as boolean | undefined) ?? cfg.quiet
	const client = makeClient(cfg)

	const results: Array<{ archived: boolean; id: string }> = []
	let anyNotFound = false

	for (const id of positionals) {
		const res = await client.api.v1.memory[':id'].archive.$post({ param: { id } })
		const result = await res.json()
		if ('error' in result) {
			if (res.status === 404) {
				anyNotFound = true
				printError(`Memory not found: ${id}`)
			} else {
				printError(result.error)
				process.exit(1)
			}
		} else {
			results.push(result)
		}
	}

	if (useJson) {
		printJson(results)
	} else {
		for (const r of results) out(r.id)
		info(`Archived ${results.length} memor${results.length === 1 ? 'y' : 'ies'}.`, quiet)
	}

	if (anyNotFound) process.exit(2)
}

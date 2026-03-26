import { parseCommandArgs } from '../args.ts'
import type { Config } from '../config.ts'
import { makeClient } from '../client.ts'
import { out, info, printError, printJson } from '../output.ts'

export const help = `\
Usage: ghostore link [options] <from-id> <to-id> <rel-type>

Create a directed relationship between two memories.

Arguments:
  <from-id>         Source memory ID
  <to-id>           Destination memory ID
  <rel-type>        Relationship type (e.g. references, follows, related, parent)

Options:
  --reason <text>   Optional reason for the link
  --json            Output as JSON: {"ok":true}
  -q, --quiet       Suppress output
  -h, --help        Show this help

Exit codes:
  0  Success
  1  API or network error
  2  A referenced memory was not found
  4  Missing required argument

Examples:
  ghostore link mem_abc123 mem_def456 references
  ghostore link mem_abc123 mem_def456 follows --reason "sequel to meeting notes"
  ghostore link mem_abc123 mem_def456 related`

export async function run(args: string[], cfg: Config): Promise<void> {
	const { values, positionals } = parseCommandArgs({
		args,
		options: {
			reason: { type: 'string' },
			json: { type: 'boolean' },
			quiet: { type: 'boolean', short: 'q' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	}, help)

	if (values.help) {
		out(help)
		return
	}

	const [fromId, toId, relType] = positionals
	const missing = !fromId ? '<from-id>' : !toId ? '<to-id>' : !relType ? '<rel-type>' : null
	if (missing) {
		printError(`${missing} is required`, help)
		process.exit(4)
	}

	const useJson = (values.json as boolean | undefined) ?? cfg.json
	const quiet = (values.quiet as boolean | undefined) ?? cfg.quiet

	const res = await makeClient(cfg).api.v1.links.$post({
		json: {
			from_id: fromId,
			to_id: toId,
			rel_type: relType,
			reason: values.reason as string | undefined,
		},
	})
	const result = await res.json()
	if ('error' in result) {
		printError(result.error)
		process.exit(res.status === 404 ? 2 : 1)
	}

	if (useJson) {
		printJson(result)
	} else {
		out(`${fromId} -> ${toId} [${relType}]`)
		info('Link created.', quiet)
	}
}

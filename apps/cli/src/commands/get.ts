import { parseCommandArgs } from '../args.ts'
import type { Config } from '../config.ts'
import { makeClient } from '../client.ts'
import { out, printError, printJson } from '../output.ts'

export const help = `\
Usage: ghostore get [options] <id-or-path>

Fetch a memory by ID or exact path. Returns full content, metadata, tags, and links.

Arguments:
  <id-or-path>    Memory ID (mem_...) or exact path (e.g. inbox/note)

Options:
  --json          Output as JSON (full memory object)
  -q, --quiet     Suppress labels, only print raw_text
  -h, --help      Show this help

Exit codes:
  0  Success
  1  API or network error
  2  Memory not found
  4  Missing required argument

Examples:
  ghostore get mem_abc123
  ghostore get inbox/meeting-notes
  ghostore get mem_abc123 --json
  ghostore get mem_abc123 --quiet   # prints only the content`

function isMemoryId(arg: string): boolean {
	return arg.startsWith('mem_')
}

export async function run(args: string[], cfg: Config): Promise<void> {
	const { values, positionals } = parseCommandArgs({
		args,
		options: {
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

	const arg = positionals[0]
	if (!arg) {
		printError('<id-or-path> is required', help)
		process.exit(4)
	}

	const useJson = (values.json as boolean | undefined) ?? cfg.json
	const quiet = (values.quiet as boolean | undefined) ?? cfg.quiet

	const client = makeClient(cfg)

	let id = arg
	if (!isMemoryId(arg)) {
		// resolve path → id via list
		const listRes = await client.api.v1.list.$post({ json: { path_prefix: arg, limit: 10 } })
		const listBody = await listRes.json()
		if ('error' in listBody) {
			printError(String(listBody.error))
			process.exit(1)
		}
		const match = listBody.results.find((r) => r.path === arg)
		if (!match) {
			printError(`Memory not found: ${arg}`)
			process.exit(2)
		}
		id = match.id
	}

	const res = await client.api.v1.memory[':id'].$get({ param: { id } })
	const memory = await res.json()
	if ('error' in memory) {
		printError(memory.error)
		process.exit(res.status === 404 ? 2 : 1)
	}

	if (useJson) {
		printJson(memory)
		return
	}

	if (quiet) {
		out(memory.raw_text)
		return
	}

	out(`ID:        ${memory.id}`)
	out(`Path:      ${memory.path}`)
	out(`Title:     ${memory.title ?? '(none)'}`)
	out(`Tags:      ${memory.tags.length ? memory.tags.join(', ') : '(none)'}`)
	out(`Source:    ${memory.source ?? '(none)'}`)
	out(`Created:   ${memory.created_at}`)
	out(`Updated:   ${memory.updated_at}`)
	out('')
	out('--- Content ---')
	out(memory.raw_text)

	if (memory.links.length > 0) {
		out('')
		out(`--- Links (${memory.links.length}) ---`)
		for (const link of memory.links) {
			const dir = link.from_id === memory.id ? '->' : '<-'
			const peer = link.from_id === memory.id ? link.to_id : link.from_id
			const label = link.reason ? ` "${link.reason}"` : ''
			out(`  ${dir} ${peer ?? '?'} [${link.rel_type}]${label}`)
		}
	}
}

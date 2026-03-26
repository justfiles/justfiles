import { parseArgs } from 'util'
import type { Config } from '../config.ts'
import { makeClient } from '../client.ts'
import { out, info, printError, printJson, readStdin } from '../output.ts'
import { resolveDate } from '../utils.ts'

export const help = `\
Usage: ghostore write [options] [content]

Write a memory. Content can be a positional argument or piped via stdin.

Options:
  -p, --path <path>         Path for the memory [default: inbox/<timestamp>]
  -t, --title <text>        Title for the memory
  --tags <tag,...>          Comma-separated list of tags
  --mode <w|a|x>            Write mode: w=overwrite (default), a=append, x=exclusive
  --source <source>         Origin label (e.g. agent, human)
  --created-at <date>       Override creation timestamp (YYYY-MM-DD or ISO 8601, for imports)
  --updated-at <date>       Override updated timestamp (YYYY-MM-DD or ISO 8601, for imports)
  --json                    Output as JSON: {"id":"mem_..."}
  -q, --quiet               Suppress informational output
  -h, --help                Show this help

Stdin:
  Pipe or redirect file content:
    echo "hello" | ghostore write --path notes/greeting
    ghostore write --path inbox/idea < idea.md

Exit codes:
  0  Success — prints memory ID on stdout
  1  API or network error
  3  Conflict (path exists in exclusive mode)
  4  Missing required content

Examples:
  ghostore write --path inbox/note --title "Meeting notes" "discussed Q2 goals"
  ghostore write --path daily/log --mode a "added another entry"
  ghostore write --path archive/old --created-at 2025-01-15 "old note"       # date only
  ghostore write --path archive/old --created-at yesterday "old note"        # natural word
  ghostore write --path archive/old --created-at 2025-01-15T09:00:00Z "old note"  # full ISO
  ID=\$(ghostore write --path inbox/idea "great idea")`

export async function run(args: string[], cfg: Config): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			path: { type: 'string', short: 'p' },
			title: { type: 'string', short: 't' },
			tags: { type: 'string' },
			mode: { type: 'string' },
			source: { type: 'string' },
			'created-at': { type: 'string' },
			'updated-at': { type: 'string' },
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

	const useJson = (values.json as boolean | undefined) ?? cfg.json
	const quiet = (values.quiet as boolean | undefined) ?? cfg.quiet

	let content = positionals.join(' ')
	if (!content) content = await readStdin()

	if (!content) {
		printError('content is required — pass it as an argument or pipe via stdin', help)
		process.exit(4)
	}

	const tags = values.tags
		? (values.tags as string).split(',').map((t) => t.trim()).filter(Boolean)
		: undefined

	const modeRaw = values.mode as string | undefined
	const mode = (modeRaw === 'w' || modeRaw === 'a' || modeRaw === 'x') ? modeRaw : undefined

	const res = await makeClient(cfg).api.v1.write.$post({
		json: {
			content,
			path: values.path as string | undefined,
			title: values.title as string | undefined,
			tags,
			mode,
			source: values.source as string | undefined,
			created_at: values['created-at'] ? resolveDate(values['created-at'] as string, 'since') : undefined,
			updated_at: values['updated-at'] ? resolveDate(values['updated-at'] as string, 'since') : undefined,
		},
	})
	const result = await res.json()
	if ('error' in result) {
		printError(result.error)
		process.exit(res.status === 409 ? 3 : 1)
	}
	if (useJson) {
		printJson(result)
	} else {
		out(result.id)
		info('Memory written.', quiet)
	}
}

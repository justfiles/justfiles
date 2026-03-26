import { parseArgs } from 'util'
import type { Config } from '../config.ts'
import { makeClient } from '../client.ts'
import { out, info, printError, printJson, readStdin } from '../output.ts'
import { resolveDate } from '../utils.ts'

export const help = `\
Usage: ghostore update [options] <id>

Update an existing memory's metadata and/or content.
At least one of --path, --title, --tags, --content, or --stdin must be provided.

Arguments:
  <id>                  Memory ID to update (e.g. mem_abc123)

Options:
  --path <path>         New path for the memory
  --title <text>        New title
  --tags <tag,...>      New tag list (fully replaces existing tags)
  --content <text>      New content (rechunks and re-embeds)
  --stdin               Read new content from stdin instead of --content
  --created-at <date>   Override creation timestamp (YYYY-MM-DD or ISO 8601, for imports)
  --updated-at <date>   Override updated timestamp (YYYY-MM-DD or ISO 8601, for imports)
  --json                Output as JSON: {"ok":true}
  -q, --quiet           Suppress output
  -h, --help            Show this help

Exit codes:
  0  Success
  1  API or network error
  2  Memory not found
  4  Missing required argument

Examples:
  ghostore update mem_abc123 --title "New Title"
  ghostore update mem_abc123 --tags "work,done"
  ghostore update mem_abc123 --path projects/done/task-1
  echo "updated content" | ghostore update mem_abc123 --stdin
  ghostore update mem_abc123 --created-at 2025-01-15        # date only
  ghostore update mem_abc123 --created-at yesterday         # natural word
  ghostore update mem_abc123 --created-at 2025-01-15T09:00:00Z  # full ISO`

export async function run(args: string[], cfg: Config): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			path: { type: 'string' },
			title: { type: 'string', short: 't' },
			tags: { type: 'string' },
			content: { type: 'string' },
			stdin: { type: 'boolean' },
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

	const id = positionals[0]
	if (!id) {
		printError('<id> is required', help)
		process.exit(4)
	}

	const useJson = (values.json as boolean | undefined) ?? cfg.json
	const quiet = (values.quiet as boolean | undefined) ?? cfg.quiet

	let content = values.content as string | undefined
	if (values.stdin) {
		content = await readStdin()
		if (!content) {
			printError('stdin was empty — nothing to update')
			process.exit(4)
		}
	}

	const tags = values.tags
		? (values.tags as string).split(',').map((t) => t.trim()).filter(Boolean)
		: undefined

	const hasUpdate = values.path || values.title || tags || content || values['created-at'] || values['updated-at']
	if (!hasUpdate) {
		printError('at least one of --path, --title, --tags, --content, or --stdin is required', help)
		process.exit(4)
	}

	const res = await makeClient(cfg).api.v1.update.$post({
		json: {
			id,
			path: values.path as string | undefined,
			title: values.title as string | undefined,
			tags,
			content,
			created_at: values['created-at'] ? resolveDate(values['created-at'] as string, 'since') : undefined,
			updated_at: values['updated-at'] ? resolveDate(values['updated-at'] as string, 'since') : undefined,
		},
	})
	const result = await res.json()
	if ('error' in result) {
		printError(String(result.error))
		process.exit(res.status === 404 ? 2 : 1)
	}

	if (useJson) {
		printJson(result)
	} else {
		out(id)
		info(`Memory updated.`, quiet)
	}
}

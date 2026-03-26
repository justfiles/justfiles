import { parseCommandArgs } from '../args.ts'
import type { Config } from '../config.ts'
import { makeClient } from '../client.ts'
import { out, printError, printJson } from '../output.ts'
import { resolveDate } from '../utils.ts'

export const help = `\
Usage: ghostore list [options]

List memories by path or tag. Results are ordered by updated_at descending.

Options:
  --path <prefix>           Return memories whose path starts with this prefix
  --pattern <glob>          Glob-style path match (e.g. "work/*/notes")
  --tags <tag,...>          Filter by comma-separated tags
  --limit <n>               Max results per page [default: 50, max: 200]
  --cursor <cursor>         Pagination cursor from a previous list response
  --archived                List archived memories instead of active ones
  --since <date>            Filter by updated_at >= date (applied to last-modified)
  --until <date>            Filter by updated_at <= date (applied to last-modified)
  --created-since <date>    Filter by created_at >= date
  --created-until <date>    Filter by created_at <= date
  --json                    Output as JSON: {"results":[...],"next_cursor":"..."}
  -q, --quiet               Only print memory IDs, one per line
  -h, --help                Show this help

Date formats accepted by --since / --until / --created-since / --created-until:
  7d, 2w, 1m, 3h           Relative duration (d=days, w=weeks, mo=months, h=hours)
  today, yesterday          Natural words
  2026-03-01               Date only (since=start of day, until=end of day)
  2026-03-01T14:30:00Z     Full ISO 8601 datetime

Exit codes:
  0  Success
  1  API or network error

Examples:
  ghostore list --path inbox
  ghostore list --tags to-process
  ghostore list --since 7d                          # updated in last 7 days
  ghostore list --since yesterday                   # updated since yesterday
  ghostore list --since 2026-03-01                  # date only
  ghostore list --since 2026-03-01 --until 2026-03-31
  ghostore list --since 2026-03-01T00:00:00Z        # full ISO datetime
  ghostore list --created-since 2026-01-01 --path inbox
  ghostore list --path ghostore/todo --json | jq '.results[].id'`

export async function run(args: string[], cfg: Config): Promise<void> {
	const { values } = parseCommandArgs({
		args,
		options: {
			path: { type: 'string' },
			pattern: { type: 'string' },
			tags: { type: 'string' },
			limit: { type: 'string' },
			cursor: { type: 'string' },
			archived: { type: 'boolean' },
			since: { type: 'string' },
			until: { type: 'string' },
			'created-since': { type: 'string' },
			'created-until': { type: 'string' },
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

	const useJson = (values.json as boolean | undefined) ?? cfg.json
	const quiet = (values.quiet as boolean | undefined) ?? cfg.quiet

	const tags = values.tags
		? (values.tags as string).split(',').map((t) => t.trim()).filter(Boolean)
		: undefined

	const limit = values.limit ? parseInt(values.limit as string, 10) : undefined

	const since = values.since ? resolveDate(values.since as string, 'since') : undefined
	const until = values.until ? resolveDate(values.until as string, 'until') : undefined
	const createdSince = values['created-since'] ? resolveDate(values['created-since'] as string, 'since') : undefined
	const createdUntil = values['created-until'] ? resolveDate(values['created-until'] as string, 'until') : undefined

	const res = await makeClient(cfg).api.v1.list.$post({
		json: {
			path_prefix: values.path as string | undefined,
			path_pattern: values.pattern as string | undefined,
			tags: tags?.length === 1 ? tags[0] : tags,
			limit,
			cursor: values.cursor as string | undefined,
			archived: values.archived as boolean | undefined,
			updated: since || until ? { after: since, before: until } : undefined,
			created: createdSince || createdUntil ? { after: createdSince, before: createdUntil } : undefined,
		},
	})
	const result = await res.json()
	if ('error' in result) {
		printError(String(result.error))
		process.exit(1)
	}

	if (useJson) {
		printJson(result)
		return
	}

	if (quiet) {
		for (const r of result.results) out(r.id)
		return
	}

	if (result.results.length === 0) {
		out('No memories found.')
		return
	}

	const idW = 20
	const pathW = 40

	out(`${result.results.length} memor${result.results.length === 1 ? 'y' : 'ies'}\n`)
	for (const r of result.results) {
		const id = r.id.padEnd(idW)
		const path = r.path.length > pathW ? '…' + r.path.slice(-(pathW - 1)) : r.path.padEnd(pathW)
		const title = r.title ?? '(no title)'
		const tagStr = r.tags.length ? `  [${r.tags.join(', ')}]` : ''
		out(`  ${id}  ${path}  ${title}${tagStr}`)
	}

	if (result.next_cursor) {
		out(`\nNext page: --cursor ${result.next_cursor}`)
	}
}

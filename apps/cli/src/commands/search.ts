import { parseCommandArgs } from '../args.ts'
import type { Config } from '../config.ts'
import { makeClient } from '../client.ts'
import { out, printError, printJson } from '../output.ts'

export const help = `\
Usage: ghostore search [options] <query>

Search memories using semantic, full-text, or hybrid search.

Arguments:
  <query>                   Search query

Options:
  --mode <mode>             Search mode: hybrid (default), semantic, exact
  --limit <n>               Max results to return [default: 10, max: 100]
  --min-score <n>           Minimum relevance score 0-1 [default: none]
  --path <prefix>           Filter by path prefix
  --tags <tag,...>          Filter by comma-separated tags
  --decay                   Apply time-based decay to boost recent memories
  --decay-half-life <days>  Half-life in days for temporal decay [default: 30]
  --debug                   Include internal scoring details in JSON output
  --json                    Output as JSON: {"results":[...]}
  -q, --quiet               Only print memory IDs, one per line
  -h, --help                Show this help

Exit codes:
  0  Success (0 results is still success)
  1  API or network error
  4  Missing required query

Examples:
  ghostore search "meeting notes from Q2"
  ghostore search "ideas" --path inbox --limit 5
  ghostore search "todo" --tags work,urgent --json --debug
  ghostore search "architecture" --mode semantic --min-score 0.7
  ghostore search "recent notes" --decay --decay-half-life 7`

export async function run(args: string[], cfg: Config): Promise<void> {
	const { values, positionals } = parseCommandArgs({
		args,
		options: {
			mode: { type: 'string' },
			limit: { type: 'string' },
			'min-score': { type: 'string' },
			path: { type: 'string' },
			tags: { type: 'string' },
			decay: { type: 'boolean' },
			'decay-half-life': { type: 'string' },
			debug: { type: 'boolean' },
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

	const query = positionals.join(' ')
	if (!query) {
		printError('<query> is required', help)
		process.exit(4)
	}

	const useJson = (values.json as boolean | undefined) ?? cfg.json
	const quiet = (values.quiet as boolean | undefined) ?? cfg.quiet

	const modeRaw = values.mode as string | undefined
	const mode =
		modeRaw === 'semantic' || modeRaw === 'exact' || modeRaw === 'hybrid' ? modeRaw : undefined

	const limit = values.limit ? parseInt(values.limit as string, 10) : undefined
	const minScore = values['min-score'] ? parseFloat(values['min-score'] as string) : undefined

	const tags = values.tags
		? (values.tags as string).split(',').map((t) => t.trim()).filter(Boolean)
		: undefined

	const filter =
		values.path || tags
			? { fields: { path_prefix: values.path as string | undefined, tags } }
			: undefined

	const decay = values.decay as boolean | undefined
	const decayHalfLife = values['decay-half-life'] ? parseFloat(values['decay-half-life'] as string) : undefined
	const options = decay ? { temporal_decay: true, decay_half_life_days: decayHalfLife } : undefined
	const debug = values.debug as boolean | undefined

	const res = await makeClient(cfg).api.v1.search.$post({
		json: { query, mode, limit, min_score: minScore, debug, filter, options },
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
		for (const r of result.results) out(r.memory_id)
		return
	}

	if (result.results.length === 0) {
		out('No results.')
		return
	}

	out(`Found ${result.results.length} result${result.results.length === 1 ? '' : 's'}\n`)
	for (let i = 0; i < result.results.length; i++) {
		const r = result.results[i]
		out(`[${i + 1}] ${r.memory_id}  score=${r.score.toFixed(3)}`)
		out(`    Path:    ${r.path}`)
		if (r.title) out(`    Title:   ${r.title}`)
		if (r.snippet) out(`    Snippet: ${r.snippet}`)
		out('')
	}
}

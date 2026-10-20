import type { Volume } from '@justfiles/fs'
import { type MirroredEntry, parseLines } from './mirror.ts'
import * as paths from './paths.ts'
import { names, readText } from './sections.ts'
import { formatInTimezone } from './timezone.ts'
import type { Tool } from './types.ts'

/** Of the matches, the newest this many are shown. */
const SEARCH_LIMIT = 30
/** A collapsed line keeps this many characters. */
const LINE_LIMIT = 200

interface Params {
	action: 'search' | 'show'
	query?: string
	shell?: string
	since?: string
	date?: string
	range?: string
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Every shell's mirrored transcript, searched and shown as text with times in `timeZone`. */
export function transcriptTool(volume: Volume, timeZone: string): Tool<Params> {
	return {
		name: 'transcript',
		description: `Read the conversations of every shell, this one included, from their mirrored transcripts under ${paths.transcriptsDir()}.
- search: the newest ${SEARCH_LIMIT} entries holding every word of \`query\`, oldest first, optionally only from \`shell\` and from \`since\` (YYYY-MM-DD) on.
- show: one shell's day (\`shell\`, \`date\` YYYY-MM-DD), optionally a \`range\` of entry numbers as search and show print them, "12" or "12-30".
Tool calls and results are collapsed to one line each.`,
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['search', 'show'] },
				query: { type: 'string', description: 'search: words that must all appear, any case.' },
				shell: {
					type: 'string',
					description: 'A shell id, as its transcripts directory is named.'
				},
				since: { type: 'string', description: 'search: the oldest day to look in, YYYY-MM-DD.' },
				date: { type: 'string', description: 'show: the day, YYYY-MM-DD.' },
				range: { type: 'string', description: 'show: entry numbers, "12" or "12-30".' }
			},
			required: ['action']
		},
		async execute(params) {
			const { shell } = params
			if (shell !== undefined && (shell.includes('/') || shell === '.' || shell === '..'))
				throw new Error(`Not a shell id: ${shell}`)
			return { text: params.action === 'show' ? await show(params) : await search(params) }
		}
	}

	async function search({ query = '', shell, since }: Params): Promise<string> {
		if (since !== undefined && !DAY.test(since))
			throw new Error(`since is not YYYY-MM-DD: ${since}`)
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
		const matches: { shell: string; day: string; n: number; entry: MirroredEntry }[] = []
		const shells = shell === undefined ? await names(volume, paths.transcriptsDir()) : [shell]
		for (const id of shells)
			for (const file of await names(volume, paths.shellTranscripts(id))) {
				const day = file.slice(0, -'.jsonl'.length)
				if (!file.endsWith('.jsonl') || (since !== undefined && day < since)) continue
				const entries = parseLines(
					(await readText(volume, `${paths.shellTranscripts(id)}/${file}`)) ?? ''
				)
				entries.forEach((entry, i) => {
					const haystack = said(entry).toLowerCase()
					if (terms.every((term) => haystack.includes(term)))
						matches.push({ shell: id, day, n: i + 1, entry })
				})
			}
		if (matches.length === 0) return 'No matches.'
		matches.sort((a, b) => a.entry.at.localeCompare(b.entry.at))
		const shown = matches.slice(-SEARCH_LIMIT)
		const lines = shown.flatMap(({ shell, day, n, entry }) =>
			render(entry, n).map((line) => `${shell} ${day} ${collapse(line)}`)
		)
		const older = matches.length - shown.length
		if (older > 0) lines.unshift(`${older} older matches not shown; narrow with shell or since.`)
		return [`Times in ${timeZone}.`, ...lines].join('\n')
	}

	async function show({ shell, date, range }: Params): Promise<string> {
		if (shell === undefined) throw new Error('show needs a shell.')
		if (date === undefined || !DAY.test(date)) throw new Error('show needs a date, YYYY-MM-DD.')
		const text = await readText(volume, paths.transcript(shell, date))
		if (text === undefined) throw new Error(`No transcript for shell ${shell} on ${date}.`)
		const [from, to] = bounds(range)
		const lines = parseLines(text).flatMap((entry, i) =>
			i + 1 >= from && i + 1 <= to ? render(entry, i + 1) : []
		)
		return [`Shell ${shell}, ${date}, times in ${timeZone}.`, ...lines].join('\n')
	}

	/** An entry as text: its first line numbered and timed, each tool call on a line of its own. */
	function render(entry: MirroredEntry, n: number): string[] {
		const head = `#${n} ${formatInTimezone(new Date(entry.at), timeZone).slice(11, 16)}`
		switch (entry.kind) {
			case 'user':
				return [`${head} user: ${entry.text}`]
			case 'assistant':
				return [
					...(entry.text === '' && entry.toolCalls.length > 0
						? []
						: [`${head} assistant: ${entry.text}`]),
					...entry.toolCalls.map((call) =>
						collapse(`${head} → ${call.name} ${JSON.stringify(call.args)}`)
					),
					...(entry.error === undefined ? [] : [`${head} (failed: ${entry.error})`])
				]
			case 'tool':
				return [
					collapse(`${head} ← ${entry.name}${entry.isError ? ' (error)' : ''}: ${entry.text}`)
				]
			case 'reset':
				return [`${head} new session${entry.handoff ? `: ${entry.handoff}` : ''}`]
			case 'compaction':
				return [collapse(`${head} compacted: ${entry.summary}`)]
		}
	}
}

/** Everything an entry says, to search in. */
function said(entry: MirroredEntry): string {
	switch (entry.kind) {
		case 'user':
			return entry.text
		case 'assistant':
			return [
				entry.text,
				...entry.toolCalls.map((call) => `${call.name} ${JSON.stringify(call.args)}`)
			].join('\n')
		case 'tool':
			return `${entry.name}\n${entry.text}`
		case 'reset':
			return entry.handoff ?? ''
		case 'compaction':
			return entry.summary
	}
}

/** `range` as inclusive entry numbers; all of them without one. */
function bounds(range: string | undefined): [number, number] {
	if (range === undefined) return [1, Number.POSITIVE_INFINITY]
	const match = range.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/)
	if (!match) throw new Error(`range is not "N" or "N-M": ${range}`)
	const from = Number(match[1])
	return [from, match[2] === undefined ? from : Number(match[2])]
}

function collapse(line: string): string {
	const flat = line.replace(/\s+/g, ' ').trim()
	return flat.length > LINE_LIMIT ? `${flat.slice(0, LINE_LIMIT)}…` : flat
}

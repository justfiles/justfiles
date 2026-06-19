/**
 * Agent filesystem tools — thin wrappers around a @justfiles/fs Volume.
 *
 * Each tool follows the AgentTool interface from pi-agent-core:
 * name, label, description, parameters (TypeBox), execute.
 */

import type { Volume } from '@justfiles/fs'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import Type from 'typebox'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type FsTool =
	| AgentTool<typeof readParams>
	| AgentTool<typeof writeParams>
	| AgentTool<typeof lsParams>
	| AgentTool<typeof mkdirParams>
	| AgentTool<typeof rmParams>

export interface FsToolset {
	tools: FsTool[]
}

export function createFsTools(vol: Volume): FsToolset {
	// Maps path → mtimeNs at the time of last read. Used to detect external modifications.
	const readMtimes = new Map<string, bigint>()

	const readFile: AgentTool<typeof readParams> = {
		name: 'read',
		label: 'Read File',
		description:
			'Read the contents of a file from your memory filesystem. Returns the file content as text.',
		parameters: readParams,
		async execute(_toolCallId, params) {
			const [data, stat] = await Promise.all([vol.readFile(params.path), vol.stat(params.path)])
			readMtimes.set(params.path, stat.mtimeNs)
			const text = decoder.decode(data)
			return {
				content: [{ type: 'text', text }],
				details: { path: params.path, size: data.length }
			}
		}
	}

	const writeFile: AgentTool<typeof writeParams> = {
		name: 'write',
		label: 'Write File',
		description:
			'Write text content to a file in your memory filesystem. Creates the file if it does not exist, overwrites if it does. Parent directories are created automatically. You MUST call `read` on the path first if the file already exists — otherwise the write is blocked.',
		parameters: writeParams,
		async execute(_toolCallId, params) {
			if (await vol.exists(params.path)) {
				const lastReadMtime = readMtimes.get(params.path)
				if (lastReadMtime === undefined) {
					throw new Error(
						`Refusing to overwrite ${params.path}: call \`read\` on it first, then write the merged content.`
					)
				}
				const current = await vol.stat(params.path)
				if (current.mtimeNs !== lastReadMtime) {
					readMtimes.delete(params.path)
					throw new Error(
						`Refusing to overwrite ${params.path}: file was modified since last read. Call \`read\` again to get the latest content.`
					)
				}
			}
			const data = encoder.encode(params.content)
			const parent = params.path.replace(/\/[^/]*$/, '')
			if (parent && parent !== params.path) {
				await vol.mkdir(parent, { recursive: true })
			}
			await vol.writeFile(params.path, data)
			const stat = await vol.stat(params.path)
			readMtimes.set(params.path, stat.mtimeNs)
			return {
				content: [{ type: 'text', text: `Wrote ${data.length} bytes to ${params.path}` }],
				details: { path: params.path, size: data.length }
			}
		}
	}

	const listDir: AgentTool<typeof lsParams> = {
		name: 'ls',
		label: 'List Directory',
		description:
			'List the contents of a directory in your memory filesystem. Returns file names and types.',
		parameters: lsParams,
		async execute(_toolCallId, params) {
			const entries = await vol.readdir(params.path)
			const lines = entries.map((e) => {
				const typeLabel = e.type === 1 ? 'dir' : 'file'
				return `${typeLabel}\t${e.name}`
			})
			const text = lines.length > 0 ? lines.join('\n') : '(empty directory)'
			return {
				content: [{ type: 'text', text }],
				details: { path: params.path, count: entries.length }
			}
		}
	}

	const makeDir: AgentTool<typeof mkdirParams> = {
		name: 'mkdir',
		label: 'Create Directory',
		description:
			'Create a directory in your memory filesystem. Use recursive: true to create parent directories as needed.',
		parameters: mkdirParams,
		async execute(_toolCallId, params) {
			await vol.mkdir(params.path, { recursive: params.recursive ?? true })
			return {
				content: [{ type: 'text', text: `Created directory ${params.path}` }],
				details: { path: params.path }
			}
		}
	}

	const removeFile: AgentTool<typeof rmParams> = {
		name: 'rm',
		label: 'Remove',
		description:
			'Remove a file or directory from your memory filesystem. Use recursive: true to remove non-empty directories.',
		parameters: rmParams,
		async execute(_toolCallId, params) {
			await vol.rm(params.path, {
				recursive: params.recursive ?? false,
				force: params.force ?? false
			})
			return {
				content: [{ type: 'text', text: `Removed ${params.path}` }],
				details: { path: params.path }
			}
		}
	}

	return {
		tools: [readFile, writeFile, listDir, makeDir, removeFile]
	}
}

const fetchParams = Type.Object({
	url: Type.String({ description: 'Absolute https:// URL of the web page to read' })
})

const searchParams = Type.Object({
	query: Type.String({ description: 'Search query' })
})

export function createSearchTool(): AgentTool<typeof searchParams> {
	return {
		name: 'search',
		label: 'Web Search',
		description:
			'Search the web and return a list of results (title, url, snippet). Use this to find pages, then call the fetch tool on promising URLs to read their contents.',
		parameters: searchParams,
		async execute(_toolCallId, params, signal) {
			const res = await fetch('https://html.duckduckgo.com/html/', {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					'user-agent': 'Mozilla/5.0 (compatible; FrierenAgent/1.0)'
				},
				body: `q=${encodeURIComponent(params.query)}`,
				signal
			})
			if (!res.ok) {
				throw new Error(`DuckDuckGo returned HTTP ${res.status}`)
			}
			const html = await res.text()
			const results = parseDuckDuckGoResults(html).slice(0, 10)
			if (results.length === 0) {
				return {
					content: [{ type: 'text', text: `No results for "${params.query}".` }],
					details: { query: params.query, count: 0 }
				}
			}
			const text = results
				.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
				.join('\n\n')
			return {
				content: [{ type: 'text', text }],
				details: { query: params.query, count: results.length, results }
			}
		}
	}
}

interface SearchResult {
	title: string
	url: string
	snippet: string
}

function parseDuckDuckGoResults(html: string): SearchResult[] {
	const results: SearchResult[] = []
	const blockRe =
		/<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
	let match = blockRe.exec(html)
	while (match !== null) {
		const rawUrl = decodeHtmlEntities(match[1] ?? '')
		results.push({
			url: unwrapDuckDuckGoUrl(rawUrl),
			title: stripTags(match[2] ?? ''),
			snippet: stripTags(match[3] ?? '')
		})
		match = blockRe.exec(html)
	}
	return results
}

function stripTags(s: string): string {
	return decodeHtmlEntities(s.replace(/<[^>]+>/g, ''))
		.replace(/\s+/g, ' ')
		.trim()
}

function decodeHtmlEntities(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x2F;/g, '/')
}

function unwrapDuckDuckGoUrl(url: string): string {
	// DDG wraps outbound links like //duckduckgo.com/l/?uddg=<encoded>&rut=...
	const match = url.match(/[?&]uddg=([^&]+)/)
	if (match) return decodeURIComponent(match[1] ?? '')
	if (url.startsWith('//')) return `https:${url}`
	return url
}

const takeNoteParams = Type.Object({
	content: Type.String({
		description:
			'One short sentence capturing a durable fact, preference, decision, or follow-up worth remembering across sessions.'
	})
})

export function createTakeNoteTool(
	append: (content: string) => Promise<void>
): AgentTool<typeof takeNoteParams> {
	return {
		name: 'takeNote',
		label: 'Take Note',
		description:
			'Record a durable note for the current session. Use when the user tells you a fact, preference, decision, or follow-up worth remembering across sessions. Notes are reviewed when the session closes and may become permanent memory.',
		parameters: takeNoteParams,
		async execute(_toolCallId, params) {
			const content = params.content.trim()
			if (content.length === 0) {
				return {
					content: [{ type: 'text', text: 'Empty note, skipped.' }],
					details: { skipped: true }
				}
			}
			await append(content)
			return {
				content: [{ type: 'text', text: `Noted: ${content}` }],
				details: { content }
			}
		}
	}
}

const askUserParams = Type.Object({
	question: Type.String({ description: 'The question to put to the user.' }),
	options: Type.Array(Type.String({ description: 'A short, selectable answer.' }), {
		description: 'The choices the user picks from (a handful of short labels).'
	})
})

// Ask the user a multiple-choice question WITHOUT suspending the turn. The tool
// hands the question + options to the host (which records it as the assistant turn
// and pings a `question` notification); the turn then completes. The user's pick is
// just the next prompt — no blocking elicitation, no coroutine. (notify Slice 3.)
export function createAskUserTool(
	onAsk: (question: string, options: string[]) => void
): AgentTool<typeof askUserParams> {
	return {
		name: 'ask_user',
		label: 'Ask User',
		description:
			'Ask the user a multiple-choice question when you genuinely need them to choose between options to proceed. Provide a clear question and the selectable answers. Do NOT keep talking afterwards — end your turn; the user’s selection arrives as the next message.',
		parameters: askUserParams,
		async execute(_toolCallId, params) {
			const question = params.question.trim()
			const options = params.options.map((o) => o.trim()).filter(Boolean)
			onAsk(question, options)
			return {
				content: [
					{
						type: 'text',
						text: 'Posed the question to the user; their selection arrives as the next message. End your turn now without further commentary.'
					}
				],
				details: { question, options }
			}
		}
	}
}

export function createFetchTool(): AgentTool<typeof fetchParams> {
	return {
		name: 'fetch',
		label: 'Fetch Web Page',
		description:
			'Fetch a web page and return its main content as clean markdown. Ads, navigation, and boilerplate are stripped. Use for reading articles, docs, blog posts, or any public web page. Response is truncated to 100KB.',
		parameters: fetchParams,
		async execute(_toolCallId, params, signal) {
			const endpoint = `https://readable.page/md?url=${encodeURIComponent(params.url)}`
			const res = await fetch(endpoint, { signal })
			const raw = await res.text()
			if (!res.ok) {
				throw new Error(`readable.page returned HTTP ${res.status}: ${raw.slice(0, 500)}`)
			}
			const MAX = 100_000
			const text =
				raw.length > MAX ? `${raw.slice(0, MAX)}\n…[truncated ${raw.length - MAX} bytes]` : raw
			return {
				content: [{ type: 'text', text }],
				details: { url: params.url, bytes: raw.length }
			}
		}
	}
}

// ── TypeBox parameter schemas ─────────────────────────────────────────────

const readParams = Type.Object({
	path: Type.String({ description: 'Absolute path to the file (must start with /)' })
})

const writeParams = Type.Object({
	path: Type.String({ description: 'Absolute path to the file (must start with /)' }),
	content: Type.String({ description: 'Text content to write' })
})

const lsParams = Type.Object({
	path: Type.String({ description: 'Absolute path to the directory (must start with /)' })
})

const mkdirParams = Type.Object({
	path: Type.String({ description: 'Absolute path for the new directory' }),
	recursive: Type.Optional(
		Type.Boolean({ description: 'Create parent directories if needed (default: true)' })
	)
})

const rmParams = Type.Object({
	path: Type.String({ description: 'Absolute path to remove' }),
	recursive: Type.Optional(
		Type.Boolean({ description: 'Remove directories and their contents recursively' })
	),
	force: Type.Optional(Type.Boolean({ description: 'Do not error if the path does not exist' }))
})

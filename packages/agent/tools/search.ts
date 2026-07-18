/**
 * Web search tool — a DuckDuckGo HTML-endpoint scrape returning title/url/snippet.
 * Pair with the fetch tool: search to find pages, fetch to read them.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core'
import Type from 'typebox'

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

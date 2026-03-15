import { DurableObject } from 'cloudflare:workers'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPTransport } from '@hono/mcp'
import { Hono } from 'hono'
import { z } from 'zod'
import { createApi } from '../core/api'
import { openAI } from '../core/embedding.openai'
import { openAI as llm } from '../core/llm.openai'
import type { Store } from '../core/store/types'
import { cfStore, migrateCF } from './store'

export class MemoryObject extends DurableObject<Env> {
	private readonly app: Hono

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		ctx.blockConcurrencyWhile(() => migrateCF(ctx.storage))
		const store = cfStore(ctx.storage, openAI(env.OPENAI_KEY), llm(env.OPENAI_KEY))
		const app = new Hono()
		app.route('/api', createApi(store))

		const mcpServer = new McpServer({ name: 'ghostore', version: '1.0.0' })
		const transport = new StreamableHTTPTransport()
		registerMcpTools(mcpServer, store)

		app.all('/mcp', async (c) => {
			if (!mcpServer.isConnected()) {
				await mcpServer.connect(transport)
			}
			return transport.handleRequest(c)
		})

		this.app = app
	}

	async fetch(request: Request): Promise<Response> {
		return this.app.fetch(request)
	}
}

function registerMcpTools(server: McpServer, store: Store) {
	server.registerTool(
		'capture_memory',
		{
			description:
				'Store a new memory or piece of information. Use this to save text content, notes, events, or any information that should be remembered for future retrieval.',
			inputSchema: {
				text: z.string().describe('The text content to store as a memory'),
				title: z.string().optional().describe('Optional title for the memory'),
				path: z
					.string()
					.optional()
					.describe(
						'Optional path to organize the memory hierarchically (e.g. "work/meetings", "personal/ideas"). Defaults to inbox/<timestamp>'
					),
				occurred_at: z
					.string()
					.optional()
					.describe('ISO 8601 timestamp of when the event occurred. Defaults to now'),
				tags: z
					.array(z.string())
					.optional()
					.describe('Optional tags to categorize and filter the memory'),
				source: z
					.string()
					.optional()
					.describe('Origin of the memory, e.g. "agent", "human", "system"')
			}
		},
		async (args) => {
			try {
				const id = await store.capture(args)
				return { content: [{ type: 'text', text: `Memory captured with id: ${id}` }] }
			} catch (err) {
				return {
					content: [
						{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }
					],
					isError: true
				}
			}
		}
	)

	server.registerTool(
		'search_memory',
		{
			description:
				'Search through stored memories using semantic, full-text, or hybrid search. Returns relevant memories with snippets and relevance scores. Use this to recall past information, find related notes, or answer questions from stored knowledge.',
			inputSchema: {
				query: z.string().describe('The search query to find relevant memories'),
				mode: z
					.enum(['hybrid', 'semantic', 'exact'])
					.optional()
					.describe(
						'Search mode: "hybrid" combines semantic and full-text search (default), "semantic" uses vector similarity for conceptual matches, "exact" uses full-text search for keyword matches'
					),
				limit: z
					.number()
					.min(1)
					.max(100)
					.optional()
					.describe('Maximum number of results to return (default: 10)'),
				min_score: z
					.number()
					.min(0)
					.max(1)
					.optional()
					.describe('Minimum relevance score threshold between 0 and 1'),
				filter: z
					.object({
						occurred_after: z
							.string()
							.optional()
							.describe('ISO 8601 date — only return memories after this date'),
						occurred_before: z
							.string()
							.optional()
							.describe('ISO 8601 date — only return memories before this date'),
						fields: z
							.object({
								tags: z
									.union([z.string(), z.array(z.string())])
									.optional()
									.describe('Filter by one or more tags'),
								path_prefix: z
									.string()
									.optional()
									.describe('Filter memories whose path starts with this prefix')
							})
							.optional()
					})
					.optional()
					.describe('Optional filters to narrow search results'),
				options: z
					.object({
						temporal_decay: z
							.boolean()
							.optional()
							.describe('Apply time-based decay to boost more recent memories'),
						decay_half_life_days: z
							.number()
							.optional()
							.describe('Half-life in days for temporal decay scoring')
					})
					.optional()
					.describe('Advanced scoring options')
			}
		},
		async (args) => {
			try {
				const results = await store.search(args)
				if (results.length === 0) {
					return { content: [{ type: 'text', text: 'No memories found matching your query.' }] }
				}
				const text = results
					.map(
						(r) =>
							`[${r.memory_id}] score=${r.score.toFixed(3)} | ${r.path}\n${r.snippet ?? '(no snippet)'}`
					)
					.join('\n\n')
				return { content: [{ type: 'text', text }] }
			} catch (err) {
				return {
					content: [
						{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }
					],
					isError: true
				}
			}
		}
	)

	server.registerTool(
		'update_memory',
		{
			description:
				'Update an existing memory. Supports updating metadata (path, title, tags) and/or content (text) independently. At least one field must be provided. Updating text rechunks and re-embeds the content.',
			inputSchema: {
				id: z.string().describe('The memory ID to update'),
				path: z
					.string()
					.optional()
					.describe('New path for the memory (e.g. "work/meetings/2026-03")'),
				title: z.string().optional().describe('New title for the memory'),
				tags: z
					.array(z.string())
					.optional()
					.describe('Replacement tag list — fully replaces existing tags'),
				text: z
					.string()
					.optional()
					.describe('New content — replaces existing text, rechunks and re-embeds')
			}
		},
		async (args) => {
			if (!args.path && !args.title && !args.tags && !args.text) {
				return {
					content: [
						{
							type: 'text',
							text: 'Error: at least one field (path, title, tags, text) must be provided'
						}
					],
					isError: true
				}
			}
			try {
				await store.update(args)
				return { content: [{ type: 'text', text: `Memory ${args.id} updated.` }] }
			} catch (err) {
				return {
					content: [
						{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }
					],
					isError: true
				}
			}
		}
	)

	server.registerTool(
		'list_memories',
		{
			description:
				'List memories by path prefix and/or tags without a search query. Use this to browse or enumerate memories at a known location (e.g. all inbox notes, all notes tagged "todo"). Results are ordered by occurred_at descending.',
			inputSchema: {
				path_prefix: z
					.string()
					.optional()
					.describe(
						'Return only memories whose path starts with this prefix (e.g. "inbox", "work/meetings")'
					),
				tags: z
					.union([z.string(), z.array(z.string())])
					.optional()
					.describe('Filter by one or more tags'),
				occurred_after: z
					.string()
					.optional()
					.describe('ISO 8601 date — only return memories after this date'),
				occurred_before: z
					.string()
					.optional()
					.describe('ISO 8601 date — only return memories before this date'),
				limit: z
					.number()
					.min(1)
					.max(200)
					.optional()
					.describe('Maximum number of results to return (default: 50)')
			}
		},
		async (args) => {
			try {
				const results = await store.list(args)
				if (results.length === 0) {
					return { content: [{ type: 'text', text: 'No memories found.' }] }
				}
				const text = results
					.map((r) => {
						const tags = r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : ''
						const date = r.occurred_at ? ` (${r.occurred_at.slice(0, 10)})` : ''
						return `[${r.id}] ${r.path}${tags}${date}${r.title ? ` — ${r.title}` : ''}`
					})
					.join('\n')
				return { content: [{ type: 'text', text }] }
			} catch (err) {
				return {
					content: [
						{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }
					],
					isError: true
				}
			}
		}
	)

	server.registerTool(
		'get_memory',
		{
			description:
				'Retrieve the full content of a specific memory by its ID. Use this after a search to read the complete text, metadata, and tags of a memory.',
			inputSchema: {
				id: z
					.string()
					.describe(
						'The memory ID to retrieve (obtained from capture_memory or search_memory results)'
					)
			}
		},
		async ({ id }) => {
			try {
				const memory = await store.get(id)
				const lines = [
					`ID: ${memory.id}`,
					`Title: ${memory.title ?? '(none)'}`,
					`Path: ${memory.path}`,
					`Occurred: ${memory.occurred_at ?? 'unknown'}`,
					`Source: ${memory.source ?? 'unknown'}`,
					`Tags: ${memory.tags.join(', ') || '(none)'}`,
					`Created: ${memory.created_at}`,
					``,
					memory.raw_text
				]
				return { content: [{ type: 'text', text: lines.join('\n') }] }
			} catch (err) {
				return {
					content: [
						{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }
					],
					isError: true
				}
			}
		}
	)
}

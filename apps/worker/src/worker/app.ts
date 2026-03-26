import { StreamableHTTPTransport } from '@hono/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createApi, type Store } from '@ghostore/core'
import { Hono } from 'hono'
import { z } from 'zod'

type AssetObject = {
	body: ReadableStream | null
	httpEtag: string
	writeHttpMetadata(headers: Headers): void
}

type AssetBucket = {
	put(
		key: string,
		value: File,
		options: {
			httpMetadata?: { contentType?: string }
			customMetadata?: Record<string, string>
		}
	): Promise<unknown>
	get(key: string): Promise<AssetObject | null>
}

export function createWorkerApiApp(args: { bucket: AssetBucket; store: Store }) {
	const { bucket, store } = args
	const mcpServer = new McpServer({ name: 'ghostore', version: '1.0.0' })
	const transport = new StreamableHTTPTransport()
	registerMcpTools(mcpServer, store)

	return new Hono()
		.post('/api/v1/memory/:memoryId/assets', async (c) => {
			const { memoryId } = c.req.param()
			const userId = c.req.header('x-user-id') ?? 'unknown'
			const formData = await c.req.formData()
			const file = formData.get('file') as File | null
			if (!file) return c.json({ error: 'No file provided' }, 400)

			const ext = file.name.split('.').pop()?.toLowerCase() ?? 'bin'
			const uuid = crypto.randomUUID()
			const key = `${userId}/assets/${memoryId}/${uuid}.${ext}`

			await bucket.put(key, file, {
				httpMetadata: { contentType: file.type || 'application/octet-stream' },
				customMetadata: { filename: file.name, memoryId }
			})

			return c.json({ key: `${uuid}.${ext}` })
		})
		.get('/api/v1/memory/:memoryId/assets/:filename', async (c) => {
			const { memoryId, filename } = c.req.param()
			const userId = c.req.header('x-user-id') ?? 'unknown'
			const key = `${userId}/assets/${memoryId}/${filename}`
			const object = await bucket.get(key)
			if (!object) return c.json({ error: 'Not found' }, 404)

			const headers = new Headers()
			object.writeHttpMetadata(headers)
			headers.set('etag', object.httpEtag)
			return new Response(object.body, { headers })
		})
		.route('/api', createApi(store))
		.all('/mcp', async (c) => {
			if (!mcpServer.isConnected()) {
				await mcpServer.connect(transport)
			}
			return transport.handleRequest(c)
		})
}

export type WorkerApiType = ReturnType<typeof createWorkerApiApp>

function registerMcpTools(server: McpServer, store: Store) {
	server.registerTool(
		'write_memory',
		{
			description:
				'Write a memory at a path. Supports three file-system-style modes: w (overwrite, default), a (append to existing), x (exclusive — fail if path exists). Use this to save text content, notes, events, or any information that should be remembered for future retrieval.',
			inputSchema: {
				content: z.string().describe('The text content to store as a memory'),
				path: z
					.string()
					.optional()
					.describe(
						'Path to organize the memory hierarchically (e.g. "work/meetings", "personal/ideas"). Defaults to inbox/<timestamp>.'
					),
				mode: z
					.enum(['w', 'a', 'x'])
					.optional()
					.describe(
						'Write mode (default: "w"). w=overwrite existing content; a=append to existing content separated by a horizontal rule; x=exclusive create, returns error if path already exists.'
					),
				title: z.string().optional().describe('Optional title for the memory'),
				tags: z
					.array(z.string())
					.optional()
					.describe('Optional tags to categorize and filter the memory'),
				source: z
					.string()
					.optional()
					.describe('Origin of the memory, e.g. "agent", "human", "system"'),
				created_at: z.iso
					.datetime()
					.optional()
					.describe(
						'Override the creation timestamp (ISO 8601). Use when importing from external sources.'
					),
				updated_at: z.iso
					.datetime()
					.optional()
					.describe(
						'Override the last-updated timestamp (ISO 8601). Use when importing from external sources.'
					)
			}
		},
		async (args) => {
			try {
				const id = await store.write(args)
				return { content: [{ type: 'text', text: `Memory written with id: ${id}` }] }
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
				debug: z
					.boolean()
					.optional()
					.describe('Include internal scoring details in structured search responses'),
				filter: z
					.object({
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
						(result) =>
							`[${result.memory_id}] score=${result.score.toFixed(3)} | ${result.path}\n${result.snippet ?? '(no snippet)'}`
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
				'Update an existing memory. Supports updating metadata (path, title, tags) and/or content independently. At least one field must be provided. Updating content rechunks and re-embeds.',
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
				content: z
					.string()
					.optional()
					.describe('New content — replaces existing text, rechunks and re-embeds'),
				created_at: z.iso
					.datetime()
					.optional()
					.describe(
						'Override the creation timestamp (ISO 8601). Use when importing from external sources.'
					),
				updated_at: z.iso
					.datetime()
					.optional()
					.describe(
						'Override the last-updated timestamp (ISO 8601). Use when importing from external sources.'
					)
			}
		},
		async (args) => {
			if (!args.path && !args.title && !args.tags && !args.content) {
				return {
					content: [
						{
							type: 'text',
							text: 'Error: at least one field (path, title, tags, content) must be provided'
						}
					],
					isError: true
				}
			}
			try {
				await store.update({ ...args, source: 'agent' })
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
				'List memories by path prefix and/or tags without a search query. Use this to browse or enumerate memories at a known location (e.g. all inbox notes, all notes tagged "todo"). Results are ordered by updated_at descending. Use next_cursor from the response to fetch the next page.',
			inputSchema: {
				path_prefix: z
					.string()
					.optional()
					.describe(
						'Return only memories whose path starts with this prefix (e.g. "inbox", "work/meetings")'
					),
				path_pattern: z
					.string()
					.optional()
					.describe(
						'Glob-style path match. `*` and `**` both act as wildcards (e.g. "work/*/notes", "projects/**")'
					),
				tags: z
					.union([z.string(), z.array(z.string())])
					.optional()
					.describe('Filter by one or more tags'),
				limit: z
					.number()
					.min(1)
					.max(200)
					.optional()
					.describe('Maximum number of results to return (default: 50)'),
				cursor: z
					.string()
					.optional()
					.describe('Opaque pagination cursor from a previous list_memories response'),
				created: z
					.object({
						after: z.string().optional(),
						before: z.string().optional()
					})
					.optional()
					.describe('Filter by created_at range using ISO timestamps'),
				updated: z
					.object({
						after: z.string().optional(),
						before: z.string().optional()
					})
					.optional()
					.describe('Filter by updated_at range using ISO timestamps'),
				archived: z
					.boolean()
					.optional()
					.describe('When true, list archived memories instead of active ones')
			}
		},
		async (args) => {
			try {
				const result = await store.list(args)
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
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
				'Fetch a memory by ID or exact path. Returns the full content, metadata, tags, and links for the matched memory.',
			inputSchema: {
				id: z.string().optional().describe('Memory ID to fetch'),
				path: z.string().optional().describe('Exact path to fetch instead of an ID')
			}
		},
		async (args) => {
			if (!args.id && !args.path) {
				return {
					content: [{ type: 'text', text: 'Error: either id or path must be provided' }],
					isError: true
				}
			}

			try {
				if (args.path) {
					const memory = await store.findByPath(args.path)
					if (!memory) {
						return {
							content: [{ type: 'text', text: `Memory not found for path: ${args.path}` }],
							isError: true
						}
					}
					return { content: [{ type: 'text', text: JSON.stringify(memory, null, 2) }] }
				}

				const memory = await store.get(args.id!)
				if (!memory) {
					return {
						content: [{ type: 'text', text: `Memory not found: ${args.id}` }],
						isError: true
					}
				}
				return { content: [{ type: 'text', text: JSON.stringify(memory, null, 2) }] }
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
		'archive_memory',
		{
			description:
				'Archive one or more memories by ID. Archived memories remain recoverable for 30 days before background purging.',
			inputSchema: {
				id: z
					.union([z.string(), z.array(z.string())])
					.describe('A single memory ID or a list of memory IDs to archive')
			}
		},
		async ({ id }) => {
			try {
				const result = await store.archive(id)
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
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
		'link_memories',
		{
			description:
				'Create a directed relationship between two active memories, optionally with a reason.',
			inputSchema: {
				from_id: z.string().describe('Source memory ID'),
				to_id: z.string().describe('Destination memory ID'),
				rel_type: z.string().describe('Relationship type, e.g. "references", "follows", "related"'),
				reason: z.string().optional().describe('Optional reason for the link')
			}
		},
		async (args) => {
			try {
				await store.link({ ...args, source: 'agent' })
				return {
					content: [
						{
							type: 'text',
							text: `Linked ${args.from_id} -> ${args.to_id} (${args.rel_type})`
						}
					]
				}
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

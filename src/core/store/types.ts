import { z } from 'zod'

export const CaptureInputSchema = z.object({
	text: z.string(),
	title: z.string().optional(), // if not given, potentially can generate one using lightweight LLM
	scope: z.string().optional(), // for permission, e.g. personal, team
	path: z.string().optional(), // if not provided, we will have a default one, e.g. inbox/<timestamp>
	tags: z.array(z.string()).optional(), // user defined
	source: z.string().optional() // user defined, e.g. agent, human, system
})

export const SearchInputSchema = z.object({
	query: z.string(),
	mode: z.enum(['hybrid', 'semantic', 'exact']).optional(),
	scope: z.string().optional(),
	limit: z.number().optional(),
	min_score: z.number().optional(),
	filter: z
		.object({
			fields: z
				.object({
					tags: z.union([z.string(), z.array(z.string())]).optional(),
					path_prefix: z.string().optional()
				})
				.optional()
		})
		.optional(),
	options: z
		.object({
			temporal_decay: z.boolean().optional(),
			decay_half_life_days: z.number().optional()
		})
		.optional()
})

export type CaptureInput = z.infer<typeof CaptureInputSchema>
export type SearchInput = z.infer<typeof SearchInputSchema>

export const UpdateInputSchema = z.object({
	id: z.string(),
	path: z.string().optional(),
	title: z.string().optional(),
	tags: z.array(z.string()).optional(),
	text: z.string().optional(),
	source: z.string().optional()
})

export type UpdateInput = z.infer<typeof UpdateInputSchema>

export const ListInputSchema = z.object({
	path_prefix: z.string().optional(),
	tags: z.union([z.string(), z.array(z.string())]).optional(),
	limit: z.number().optional()
})

export type ListInput = z.infer<typeof ListInputSchema>

export type ListResult = {
	id: string
	path: string
	title: string | null
	tags: string[]
	source: string | null
}

export interface Store {
	/**
	 * capture memory, return memory id
	 */
	capture(input: CaptureInput): Promise<string>

	/**
	 * search for memory
	 */
	search(input: SearchInput): Promise<SearchResult[]>

	/**
	 * update metadata and/or content of an existing memory
	 */
	update(input: UpdateInput): Promise<void>

	/**
	 * list memories by path/tags without a search query, ordered by created_at desc
	 */
	list(input: ListInput): Promise<ListResult[]>

	/**
	 * get a memory by id
	 */
	get(id: string): Promise<Memory>
}

export type SearchResult = {
	memory_id: string
	// chunk_id: string // the SearchResult maps to a chunk, but currently chunk is not useful for user
	path: string
	title: string | null
	// TODO: might be useful for a memory editor/viewer?
	// pos: number | null
	// len: number | null
	score: number
	semanticScore?: number
	ftsScore?: number
	snippet: string | null
	source?: string
}

export type Memory = {
	id: string
	scope: string
	title: string | null
	raw_text: string
	path: string // path always have value
	source: string | null
	created_at: string
	updated_at: string
	links: LinkInfo[]
	tags: string[]
}

type LinkInfo = {
	from_id?: string
	to_id?: string
	rel_type: string
	reason: string | null
	created_at: string
}

import { and, eq, gte, inArray, like, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { DBClient } from '../db'
import * as schema from '../db/schema'
import type { EmbeddingProvider } from './embedding'
import type { VectorStore } from './vector'

export const CaptureInputSchema = z.object({
	text: z.string(),
	title: z.string().optional(), // if not given, potentially can generate one using lightweight LLM
	scope: z.string().optional(), // for permission, e.g. personal, team
	path: z.string().optional(), // if not provided, we will have a default one, e.g. inbox/<timestamp>
	occurred_at: z.string().optional(), // if not given, set to now
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
			occurred_after: z.string().optional(),
			occurred_before: z.string().optional(),
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

type CaptureInput = z.infer<typeof CaptureInputSchema>
type SearchInput = z.infer<typeof SearchInputSchema>

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
	 * get a memory by id
	 */
	get(id: string): Promise<Memory>
}

type SearchResult = {
	memory_id: string
	// chunk_id: string // the SearchResult maps to a chunk, but currently chunk is not useful for user
	path: string
	// TODO: might be useful for a memory editor/viewer?
	// start_line: number | null
	// end_line: number | null
	score: number
	snippet: string | null
	occurred_at: string | null
	source?: string
}

type Memory = {
	id: string
	scope: string
	title: string | null
	raw_text: string
	path: string // path always have value
	occurred_at: string | null
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

// ---- Helpers ----

function genId(prefix: string): string {
	const ts = Date.now().toString(36)
	const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
	return `${prefix}_${ts}${rand}`
}

async function sha256hex(text: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

function normalizeText(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

function approxTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

interface TextChunk {
	seq: number
	text: string
	startLine: number
	endLine: number
	tokenCount: number
}

// Scores for boundary-aware chunking. Higher = better break point.
const BREAK_PATTERNS: Array<[RegExp, number]> = [
	[/^# /, 100],
	[/^## /, 90],
	[/^### /, 80],
	[/^#{4,}/, 60],
	[/^```/, 80],
	[/^-{3,}$/, 60],
	[/^\s*$/, 20],
	[/^[-*+] /, 5]
]

function lineBreakScore(line: string): number {
	for (const [re, score] of BREAK_PATTERNS) {
		if (re.test(line)) return score
	}
	return 1
}

function chunkText(text: string, targetTokens = 400): TextChunk[] {
	const lines = text.split('\n')
	const chunks: TextChunk[] = []
	let seq = 0
	let i = 0

	while (i < lines.length) {
		const startLine = i
		const chunkLines: string[] = []
		let tokens = 0

		while (i < lines.length) {
			const line = lines[i]
			const lt = approxTokens(`${line}\n`)
			chunkLines.push(line)
			tokens += lt
			i++

			if (tokens >= targetTokens) {
				// Look back up to 20 lines for a good break point
				const window = Math.min(20, chunkLines.length - 1)
				let bestScore = 0
				let bestJ = -1
				for (let j = chunkLines.length - 1; j >= chunkLines.length - window; j--) {
					const score = lineBreakScore(chunkLines[j])
					if (score > bestScore) {
						bestScore = score
						bestJ = j
					}
				}
				// If a meaningful break was found, return lines after it to next chunk
				if (bestScore > 1 && bestJ > 0) {
					const toReturn = chunkLines.splice(bestJ)
					i -= toReturn.length
				}
				break
			}
		}

		if (chunkLines.length > 0) {
			const ct = chunkLines.join('\n')
			chunks.push({
				seq: seq++,
				text: ct,
				startLine,
				endLine: startLine + chunkLines.length - 1,
				tokenCount: approxTokens(ct)
			})
		}
	}

	return chunks
}

function generateSnippet(text: string, query: string, maxLen = 200): string {
	const firstTerm = query.split(/\s+/)[0].toLowerCase()
	const idx = text.toLowerCase().indexOf(firstTerm)
	const start = Math.max(0, idx === -1 ? 0 : idx - 60)
	const end = Math.min(text.length, start + maxLen)
	const snippet = text.slice(start, end)
	return `${start > 0 ? '…' : ''}${snippet}${end < text.length ? '…' : ''}`
}

function applyTemporalDecay(
	score: number,
	occurredAt: string | null,
	halfLifeDays: number
): number {
	if (!occurredAt) return score
	const ageDays = (Date.now() - new Date(occurredAt).getTime()) / 86_400_000
	return score * Math.exp((-Math.LN2 / halfLifeDays) * ageDays)
}

interface CandidateChunk {
	chunkId: string
	memoryId: string
	text: string
	hash: string
	rank: number
}

// ---- Store Implementation ----

export function getStore(
	db: DBClient,
	embProvider?: EmbeddingProvider,
	vectorStore?: VectorStore
): Store {
	const embModelKey = embProvider ? `${embProvider.provider}:${embProvider.model}` : 'none'

	async function getValidMemoryIds(
		scope: string,
		filter?: SearchInput['filter']
	): Promise<string[]> {
		const rows = await db
			.select({ id: schema.memories.id })
			.from(schema.memories)
			.where(
				and(
					eq(schema.memories.active, 1),
					eq(schema.memories.scope, scope),
					filter?.occurred_after
						? gte(schema.memories.occurred_at, filter.occurred_after)
						: undefined,
					filter?.occurred_before
						? lte(schema.memories.occurred_at, filter.occurred_before)
						: undefined,
					filter?.fields?.path_prefix
						? like(schema.memories.path, `${filter.fields.path_prefix}%`)
						: undefined
				)
			)

		let ids = rows.map((r) => r.id)

		if (filter?.fields?.tags && ids.length > 0) {
			const tags = Array.isArray(filter.fields.tags) ? filter.fields.tags : [filter.fields.tags]
			if (tags.length > 0) {
				const taggedRows = await db
					.select({ memory_id: schema.memoryTags.memory_id })
					.from(schema.memoryTags)
					.where(
						and(inArray(schema.memoryTags.memory_id, ids), inArray(schema.memoryTags.tag, tags))
					)
				const taggedSet = new Set(taggedRows.map((r) => r.memory_id))
				ids = ids.filter((id) => taggedSet.has(id))
			}
		}

		return ids
	}

	function exactSearch(
		query: string,
		validIds: string[],
		candidateLimit: number
	): CandidateChunk[] {
		if (validIds.length === 0) return []

		const rows = db.all<{ id: string; memory_id: string; text: string; hash: string }>(
			sql`
				SELECT c.id, c.memory_id, c.text, c.hash
				FROM chunks_fts f
				JOIN chunks c ON c.id = f.chunk_id
				WHERE chunks_fts MATCH ${query}
				AND c.memory_id IN (${sql.join(
					validIds.map((id) => sql`${id}`),
					sql`, `
				)})
				ORDER BY f.rank
				LIMIT ${candidateLimit}
			`
		)

		return rows.map((r, rank) => ({
			chunkId: r.id,
			memoryId: r.memory_id,
			text: r.text,
			hash: r.hash,
			rank
		}))
	}

	async function semanticSearch(
		queryEmbedding: number[],
		validIds: string[],
		candidateLimit: number
	): Promise<CandidateChunk[]> {
		if (validIds.length === 0 || !embProvider || !vectorStore) return []

		const matches = await vectorStore.query({
			vector: queryEmbedding,
			topK: Math.min(100, candidateLimit),
			memoryIds: validIds
		})
		if (matches.length === 0) return []

		const chunkRows = await db
			.select({
				id: schema.chunks.id,
				memory_id: schema.chunks.memory_id,
				text: schema.chunks.text,
				hash: schema.chunks.hash
			})
			.from(schema.chunks)
			.where(
				and(
					inArray(
						schema.chunks.id,
						matches.map((c) => c.id)
					),
					inArray(schema.chunks.memory_id, validIds)
				)
			)

		if (chunkRows.length === 0) return []

		const chunkMap = new Map<string, (typeof chunkRows)[number]>()
		for (const row of chunkRows) {
			chunkMap.set(row.id, row)
		}

		const scored = matches
			.map((match, rank) => {
				const row = chunkMap.get(match.id)
				if (!row) return null
				return {
					chunkId: row.id,
					memoryId: row.memory_id,
					text: row.text,
					hash: row.hash,
					similarity: match.score,
					rank
				}
			})
			.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)

		return scored.slice(0, candidateLimit)
	}

	function rrf(lists: CandidateChunk[][], k = 60): CandidateChunk[] {
		const scores = new Map<string, { chunk: CandidateChunk; score: number }>()
		for (const list of lists) {
			for (let rank = 0; rank < list.length; rank++) {
				const chunk = list[rank]
				const add = 1 / (k + rank + 1)
				const prev = scores.get(chunk.chunkId)
				scores.set(chunk.chunkId, {
					chunk,
					score: (prev?.score ?? 0) + add
				})
			}
		}
		return Array.from(scores.values())
			.sort((a, b) => b.score - a.score)
			.map((v) => v.chunk)
	}

	async function chunksToResults(
		candidates: CandidateChunk[],
		query: string,
		limit: number,
		options?: SearchInput['options']
	): Promise<SearchResult[]> {
		if (candidates.length === 0) return []

		const memoryIds = [...new Set(candidates.map((c) => c.memoryId))]
		const memRows = await db
			.select({
				id: schema.memories.id,
				path: schema.memories.path,
				occurred_at: schema.memories.occurred_at,
				source: schema.memories.source
			})
			.from(schema.memories)
			.where(inArray(schema.memories.id, memoryIds))

		const memMap = new Map(memRows.map((m) => [m.id, m]))

		// Dedupe by memory: take the best-ranked chunk per memory
		const seen = new Set<string>()
		const results: SearchResult[] = []

		for (const chunk of candidates) {
			if (seen.has(chunk.memoryId)) continue
			seen.add(chunk.memoryId)

			const mem = memMap.get(chunk.memoryId)
			if (!mem) continue

			let score = 1 / (1 + chunk.rank)
			if (options?.temporal_decay) {
				score = applyTemporalDecay(score, mem.occurred_at, options.decay_half_life_days ?? 30)
			}

			results.push({
				memory_id: chunk.memoryId,
				path: mem.path,
				score,
				snippet: generateSnippet(chunk.text, query),
				occurred_at: mem.occurred_at,
				source: mem.source ?? undefined
			})

			if (results.length >= limit) break
		}

		return results
	}

	return {
		async capture(input: CaptureInput): Promise<string> {
			const normalized = normalizeText(input.text)
			const hash = await sha256hex(normalized)
			const now = new Date().toISOString()
			const scope = input.scope ?? 'personal'

			// Dedup: return existing memory if content is identical
			const existing = await db
				.select({ id: schema.memories.id })
				.from(schema.memories)
				.where(and(eq(schema.memories.content_hash, hash), eq(schema.memories.active, 1)))
				.limit(1)
			if (existing.length > 0) return existing[0].id

			// Path assignment; archive existing memory at same path if present
			const path = input.path ?? `inbox/${now.slice(0, 19).replace(/[:.]/g, '')}`
			if (input.path) {
				const oldMemory = await db
					.select({ id: schema.memories.id })
					.from(schema.memories)
					.where(
						and(
							eq(schema.memories.scope, scope),
							eq(schema.memories.path, input.path),
							eq(schema.memories.active, 1)
						)
					)
					.limit(1)
				if (oldMemory.length > 0) {
					const oldId = oldMemory[0].id
					await db
						.update(schema.memories)
						.set({ active: 0, updated_at: now })
						.where(eq(schema.memories.id, oldId))
					await db.insert(schema.events).values({
						id: genId('evt'),
						memory_id: oldId,
						event_type: 'archive',
						actor_type: 'system',
						at: now,
						payload_json: JSON.stringify({ reason: 'replaced by path upsert' })
					})
				}
			}

			// Chunk text
			const textChunks = chunkText(normalized)
			const chunkHashes = await Promise.all(textChunks.map((c) => sha256hex(c.text)))

			// Compute embeddings for this capture when provider + vector store are configured
			let embeddings: number[][] = []
			if (embProvider && vectorStore && chunkHashes.length > 0) {
				embeddings = await embProvider.embed(textChunks.map((c) => c.text))
			}
			const vectorsToIndex: Array<{
				id: string
				values: number[]
				metadata: {
					memory_id: string
					embedding_model: string
				}
			}> = []

			// Insert memory record
			const memoryId = genId('mem')
			await db.insert(schema.memories).values({
				id: memoryId,
				scope,
				title: input.title ?? null,
				content_hash: hash,
				path,
				occurred_at: input.occurred_at ?? null,
				source: input.source ?? null,
				active: 1,
				created_at: now,
				updated_at: now
			})

			// Insert tags
			if (input.tags?.length) {
				await db
					.insert(schema.memoryTags)
					.values(input.tags.map((tag) => ({ memory_id: memoryId, tag })))
			}

			// Insert chunks
			for (let i = 0; i < textChunks.length; i++) {
				const chunk = textChunks[i]
				const chunkId = genId('chk')
				await db.insert(schema.chunks).values({
					id: chunkId,
					memory_id: memoryId,
					seq: chunk.seq,
					start_line: chunk.startLine,
					end_line: chunk.endLine,
					text: chunk.text,
					token_count: chunk.tokenCount,
					hash: chunkHashes[i],
					embedding_model: embModelKey,
					updated_at: now
				})
				if (embeddings[i] !== undefined) {
					vectorsToIndex.push({
						id: chunkId,
						values: embeddings[i],
						metadata: {
							memory_id: memoryId,
							embedding_model: embModelKey
						}
					})
				}
			}

			if (vectorsToIndex.length > 0 && vectorStore) {
				await vectorStore.upsert(vectorsToIndex)
			}

			// Write audit event
			await db.insert(schema.events).values({
				id: genId('evt'),
				memory_id: memoryId,
				event_type: 'capture',
				actor_type: input.source ? 'agent' : 'human',
				actor_name: input.source ?? null,
				at: now,
				payload_json: null
			})

			return memoryId
		},

		async search(input: SearchInput): Promise<SearchResult[]> {
			const scope = input.scope ?? 'personal'
			const mode = input.mode ?? 'hybrid'
			const limit = input.limit ?? 10
			const candidateLimit = limit * 4
			const minScore = input.min_score ?? 0

			const validIds = await getValidMemoryIds(scope, input.filter)
			if (validIds.length === 0) return []

			let candidates: CandidateChunk[]

			if (mode === 'exact') {
				candidates = exactSearch(input.query, validIds, candidateLimit)
			} else if (mode === 'semantic') {
				if (!embProvider || !vectorStore) return []
				const [queryEmb] = await embProvider.embed([input.query])
				candidates = await semanticSearch(queryEmb, validIds, candidateLimit)
			} else {
				// hybrid: run exact and semantic in parallel, merge via RRF
				const [exactCands, semanticCands] = await Promise.all([
					exactSearch(input.query, validIds, candidateLimit),
					embProvider && vectorStore
						? embProvider
								.embed([input.query])
								.then(([emb]) => semanticSearch(emb, validIds, candidateLimit))
						: Promise.resolve([])
				])
				candidates = rrf([exactCands, semanticCands])
			}

			const results = await chunksToResults(candidates, input.query, limit, input.options)
			return results.filter((r) => r.score >= minScore)
		},

		async get(id: string): Promise<Memory> {
			const rows = await db
				.select()
				.from(schema.memories)
				.where(and(eq(schema.memories.id, id), eq(schema.memories.active, 1)))
				.limit(1)
			if (!rows.length) throw new Error(`Memory not found: ${id}`)
			const m = rows[0]

			const [tagRows, outgoing, incoming, chunkRows] = await Promise.all([
				db
					.select({ tag: schema.memoryTags.tag })
					.from(schema.memoryTags)
					.where(eq(schema.memoryTags.memory_id, id)),
				db.select().from(schema.memoryLinks).where(eq(schema.memoryLinks.from_id, id)),
				db.select().from(schema.memoryLinks).where(eq(schema.memoryLinks.to_id, id)),
				db
					.select({ text: schema.chunks.text })
					.from(schema.chunks)
					.where(eq(schema.chunks.memory_id, id))
					.orderBy(schema.chunks.seq)
			])

			// Update retrieval stats
			const now = new Date().toISOString()
			await db
				.update(schema.memories)
				.set({
					last_retrieved_at: now,
					retrieval_count: sql`${schema.memories.retrieval_count} + 1`
				})
				.where(eq(schema.memories.id, id))

			return {
				id: m.id,
				scope: m.scope,
				title: m.title,
				raw_text: chunkRows.map((c) => c.text).join('\n'),
				path: m.path,
				occurred_at: m.occurred_at,
				source: m.source,
				created_at: m.created_at,
				updated_at: m.updated_at,
				tags: tagRows.map((r) => r.tag),
				links: [
					...outgoing.map((l) => ({
						to_id: l.to_id,
						rel_type: l.rel_type,
						reason: l.reason,
						created_at: l.created_at
					})),
					...incoming.map((l) => ({
						from_id: l.from_id,
						rel_type: l.rel_type,
						reason: l.reason,
						created_at: l.created_at
					}))
				]
			}
		}
	}
}

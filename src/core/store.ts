import { z } from 'zod'
import type { EmbeddingProvider } from './embedding'
import type { LLM } from './llm'
import type { Reranker } from './reranker'
import type { DbAdapter, SqlValue } from './db'
import type { VectorStore } from './vector'

/**
 * Interface of the Store - core of the service
 * Make sure the interface here is minimal and dry. It serves as a infrastructure for all behaviours of the system.
 * make sure each function is single purpose, and composable
 * It should feel like a file system
 */
export interface Store {
	/**
	 * write memory at a path — creates or overwrites in place. returns the memory id.
	 * if the existing memory at that path already has the same hash, returns immediately (noop).
	 * AI processing (embedding, title gen) is deferred — sets dirty=1 and returns immediately.
	 */
	write(input: WriteInput): Promise<string>

	/**
	 * search for memory
	 */
	search(input: SearchInput): Promise<SearchResult[]>

	/**
	 * update metadata and/or content of an existing memory.
	 * text changes set dirty=1 and defer re-embedding to processEmbedding().
	 */
	update(input: UpdateInput): Promise<void>

	/**
	 * soft-delete a memory (sets active = 0, expires_at = 30 days from now).
	 * embeddings are kept for the 30-day recovery window.
	 */
	archive(id: string, source?: string): Promise<void>

	/**
	 * restore an archived memory (sets active = 1, clears expires_at).
	 * only works within the 30-day recovery window.
	 */
	revive(id: string, source?: string): Promise<void>

	/**
	 * hard-delete a memory — removes all data including chunks and embeddings.
	 * works on both active and archived memories.
	 */
	purge(id: string): Promise<void>

	/**
	 * purge all archived memories whose expires_at <= now.
	 * called from background jobs to clean up expired archives.
	 */
	purgeExpired(): Promise<void>

	/**
	 * list memories by path/tags without a search query, ordered by created_at desc
	 */
	list(input: ListInput): Promise<ListResult[]>

	/**
	 * get a memory by id, returns null if not found
	 */
	get(id: string): Promise<Memory | null>

	/**
	 * find a memory by exact path match, returns { id, raw_text } or null
	 */
	findByPath(path: string): Promise<{ id: string; raw_text: string } | null>

	/**
	 * get N most recently updated active memories, cached in-memory and invalidated on write/update
	 */
	recent(n: number): Promise<RecentResult[]>

	/**
	 * get all memories changed since a given updated_at timestamp (ISO string).
	 * pass empty string to get all active memories.
	 * returns upserted entries (active=1) and removed ids (active=0).
	 */
	changes(since: string): Promise<ChangesResult>

	/**
	 * create a directed link between two memories
	 */
	link(input: LinkInput): Promise<void>

	/**
	 * background worker: find dirty memories, re-embed and generate missing titles.
	 * processes up to 10 memories per call.
	 * returns true if more dirty memories remain (caller should reschedule).
	 */
	processEmbedding(): Promise<boolean>

	onUpdate(action: () => void | Promise<void>): void
}

// ---- Scoring ----

interface CandidateChunk {
	chunkId: string
	memoryId: string
	text: string
	hash: string
	rank: number
	score: number
	semanticScore?: number
	ftsRank?: number
	rerankerScore?: number
}

function normalizeBm25(ftsRank: number): number {
	const abs = Math.abs(ftsRank)
	return abs / (1 + abs)
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

// Position-aware blend: ranks 0–2 favour retrieval (75/25), ranks 10+ favour reranker (40/60).
function blendWithReranker(retrievalScore: number, rerankerScore: number, rank: number): number {
	const t = rank <= 2 ? 0 : rank >= 10 ? 1 : (rank - 2) / 8
	const retrievalWeight = 0.75 - 0.35 * t
	return Math.min(1, retrievalScore * retrievalWeight + rerankerScore * (1 - retrievalWeight))
}

// Per-list rank bonus: rewards results that dominated at least one retrieval signal.
// Added to rrfScore (affects ranking only, not the display score).
const TOP_RANK_BONUS = [0.05, 0.02, 0.02]

function rrf(lists: CandidateChunk[][], k = 60, weights?: number[]): CandidateChunk[] {
	const scores = new Map<string, { chunk: CandidateChunk; rrfScore: number }>()
	for (let li = 0; li < lists.length; li++) {
		const list = lists[li]
		const w = weights?.[li] ?? 1.0
		for (let rank = 0; rank < list.length; rank++) {
			const chunk = list[rank]
			// RRF term + per-list top-rank bonus (both weighted by list weight)
			const add = w * (1 / (k + rank + 1) + (TOP_RANK_BONUS[rank] ?? 0))
			const prev = scores.get(chunk.chunkId)
			const merged: CandidateChunk = {
				...(prev?.chunk ?? chunk),
				semanticScore: chunk.semanticScore ?? prev?.chunk.semanticScore,
				ftsRank: chunk.ftsRank ?? prev?.chunk.ftsRank
			}
			scores.set(chunk.chunkId, { chunk: merged, rrfScore: (prev?.rrfScore ?? 0) + add })
		}
	}
	// Sort by RRF score; display score is the best raw signal (independent of RRF ordering).
	return Array.from(scores.values())
		.sort((a, b) => b.rrfScore - a.rrfScore)
		.map((v) => {
			const { chunk } = v
			const ftsScore = chunk.ftsRank != null ? normalizeBm25(chunk.ftsRank) : 0
			const score = Math.max(chunk.semanticScore ?? 0, ftsScore)
			return { ...chunk, score }
		})
}

// ---- Utils ----

interface TextChunk {
	seq: number
	text: string
	pos: number
	len: number
	tokenCount: number
}


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
	// CJK characters (Chinese, Japanese, Korean) each map to ~1 BPE token because
	// LLM vocabularies have very few multi-character CJK entries. Latin/other text
	// averages ~4 chars per token, so we keep the /4 heuristic for the non-CJK portion.
	const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
	const rest = text.length - cjk
	return Math.ceil(cjk + rest / 4)
}

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
	let pos = 0

	while (i < lines.length) {
		const chunkLines: string[] = []
		let tokens = 0

		while (i < lines.length) {
			const line = lines[i]
			tokens += approxTokens(`${line}\n`)
			chunkLines.push(line)
			i++

			if (tokens >= targetTokens) {
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

				if (bestScore > 1 && bestJ > 0) {
					const toReturn = chunkLines.splice(bestJ)
					i -= toReturn.length
				}

				break
			}
		}

		if (chunkLines.length > 0) {
			const chunkTextContent = chunkLines.join('\n')
			if (!chunkTextContent.trim()) {
				pos += chunkTextContent.length + 1
				continue
			}
			chunks.push({
				seq: seq++,
				text: chunkTextContent,
				pos,
				len: chunkTextContent.length,
				tokenCount: approxTokens(chunkTextContent)
			})
			// +1 for the '\n' that was between this chunk and the next
			pos += chunkTextContent.length + 1
		}
	}

	return chunks
}

function generateSnippet(text: string, query: string, maxLen = 300): string {
	const lower = text.toLowerCase()
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean)

	if (terms.length === 0) {
		return text.slice(0, maxLen) + (text.length > maxLen ? '…' : '')
	}

	// Collect positions of every term match
	const positions: number[] = []
	for (const term of terms) {
		let idx = lower.indexOf(term)
		while (idx !== -1) {
			positions.push(idx)
			idx = lower.indexOf(term, idx + 1)
		}
	}

	// Fall back to the beginning if no terms matched
	if (positions.length === 0) {
		return text.slice(0, maxLen) + (text.length > maxLen ? '…' : '')
	}

	// Find the window that covers the most distinct terms
	let bestStart = 0
	let bestScore = -1
	for (const pos of positions) {
		const start = Math.max(0, pos - 60)
		const end = Math.min(text.length, start + maxLen)
		const window = lower.slice(start, end)
		const score = terms.filter((t) => window.includes(t)).length
		if (score > bestScore) {
			bestScore = score
			bestStart = start
		}
	}

	const end = Math.min(text.length, bestStart + maxLen)
	const snippet = text.slice(bestStart, end)
	return `${bestStart > 0 ? '…' : ''}${snippet}${end < text.length ? '…' : ''}`
}


function placeholders(count: number): string {
	return Array.from({ length: count }, () => '?').join(',')
}

function normalizeTags(tags?: string | string[]): string[] {
	if (!tags) return []
	return Array.isArray(tags) ? tags.filter(Boolean) : [tags]
}

function sanitizeFtsQuery(query: string): string {
	return query
		.split(/\s+/)
		.map((w) => w.replace(/[^\w]/g, ' ').trim())
		.filter(Boolean)
		.join(' ')
}

const STRONG_SIGNAL_MIN_SCORE = 0.85
const STRONG_SIGNAL_MIN_GAP = 0.15

function hasStrongExactSignal(exact: CandidateChunk[]): boolean {
	if (exact.length === 0) return false
	const top = exact[0].score
	if (top < STRONG_SIGNAL_MIN_SCORE) return false
	const second = exact[1]?.score ?? 0
	return top - second >= STRONG_SIGNAL_MIN_GAP
}

// ---- Types ----

export const WriteInputSchema = z.object({
	text: z.string(),
	path: z.string().optional(), // if not provided, defaults to inbox/<timestamp> (always creates)
	title: z.string().optional(),
	scope: z.string().optional(),
	tags: z.array(z.string()).optional(),
	source: z.string().optional()
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

export type WriteInput = z.infer<typeof WriteInputSchema>
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

const DateRangeSchema = z.object({
	after: z.string().optional(),
	before: z.string().optional()
})

export const ListInputSchema = z.object({
	path_prefix: z.string().optional(),
	path_pattern: z.string().optional(),
	tags: z.union([z.string(), z.array(z.string())]).optional(),
	limit: z.number().optional(),
	created: DateRangeSchema.optional(),
	updated: DateRangeSchema.optional(),
	archived: z.boolean().optional()
})

export type ListInput = z.infer<typeof ListInputSchema>

export const LinkInputSchema = z.object({
	from_id: z.string(),
	to_id: z.string(),
	rel_type: z.string(),
	reason: z.string().optional(),
	source: z.string().optional()
})

export type LinkInput = z.infer<typeof LinkInputSchema>

export type ListResult = {
	id: string
	path: string
	title: string | null
	tags: string[]
	source: string | null
}

export type RecentResult = {
	id: string
	path: string
	title: string | null
	tags: string[]
	updated_at: string
}

export type MemoryMeta = {
	id: string
	title: string | null
	path: string
	updated_at: string
	tags: string[]
	active: number
}

export type ChangesResult = {
	upserted: MemoryMeta[]
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
	rerankerScore?: number
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
	active: number
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

// ---- Migration ----

export function parseSqlStatements(sql: string): string[] {
	const statements: string[] = []
	let depth = 0
	let start = 0

	for (let i = 0; i < sql.length; i++) {
		const word = sql.slice(i).match(/^(BEGIN|END)\b/i)
		if (word) {
			if (word[1].toUpperCase() === 'BEGIN') depth++
			else depth--
		}
		if (sql[i] === ';' && depth === 0) {
			const stmt = sql.slice(start, i).trim()
			if (stmt && !stmt.startsWith('--')) statements.push(stmt)
			start = i + 1
		}
	}

	const last = sql.slice(start).trim()
	if (last && !last.startsWith('--')) statements.push(last)

	return statements.filter(Boolean)
}

// Accepts pre-loaded migration entries — works in any environment (including CF Workers).
export async function migrateFromEntries(
	adapter: DbAdapter,
	entries: Array<{ version: number; sql: string }>
): Promise<void> {
	await adapter.run(
		`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`
	)

	const [row] = await adapter.query<{ max_version: number }>(
		'SELECT MAX(version) AS max_version FROM schema_migrations'
	)
	const currentVersion = Number(row?.max_version ?? 0)

	for (const entry of entries) {
		if (entry.version <= currentVersion) continue
		for (const stmt of parseSqlStatements(entry.sql)) {
			await adapter.run(stmt)
		}
		await adapter.run(
			`INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))`,
			[entry.version]
		)
	}
}

// ---- Store Implementation ----

const RERANK_LIMIT = 40

export function createStore(
	adapter: DbAdapter,
	namespace: string,
	embProvider?: EmbeddingProvider,
	llm?: LLM,
	reranker?: Reranker,
	vectorStore?: VectorStore
): Store {
	const embModelKey = embProvider ? `${embProvider.provider}:${embProvider.model}` : 'none'
	let recentCache: RecentResult[] | null = null
	const updateListeners: Array<() => void | Promise<void>> = []

	async function notifyUpdate(): Promise<void> {
		for (const fn of updateListeners) await fn()
	}

	async function getValidMemoryIds(
		scope: string,
		filter?: SearchInput['filter']
	): Promise<string[]> {
		const tags = normalizeTags(filter?.fields?.tags)
		const conditions = ['m.scope = ?', 'm.active = 1', "m.path NOT LIKE '*%'"]
		const params: SqlValue[] = [scope]

		if (filter?.fields?.path_prefix) {
			conditions.push('m.path LIKE ?')
			params.push(`${filter.fields.path_prefix}%`)
		}

		let sql = 'SELECT DISTINCT m.id FROM memories m'

		if (tags.length > 0) {
			sql += ' JOIN memory_tags mt ON mt.memory_id = m.id'
			conditions.push(`mt.tag IN (${placeholders(tags.length)})`)
			params.push(...tags)
		}

		sql += ` WHERE ${conditions.join(' AND ')}`

		const rows = await adapter.query<{ id: unknown }>(sql, params)
		return rows.map((row) => String(row.id))
	}

	async function exactSearch(
		query: string,
		validIds: string[],
		candidateLimit: number
	): Promise<CandidateChunk[]> {
		if (validIds.length === 0) return []

		const safeQuery = sanitizeFtsQuery(query)
		if (!safeQuery) return []

		const rows = await adapter.query<{
			memory_id: unknown
			text: unknown
			hash: unknown
			fts_rank: unknown
		}>(
			`SELECT m.id as memory_id, co.text, m.content_hash as hash, f.rank as fts_rank
			 FROM memory_fts f
			 JOIN memories m ON m.id = f.memory_id
			 JOIN content co ON co.hash = m.content_hash
			 WHERE f.text MATCH ?
			 AND m.id IN (${placeholders(validIds.length)})
			 ORDER BY f.rank
			 LIMIT ?`,
			[safeQuery, ...validIds, candidateLimit]
		)

		return rows.map((row, rank) => ({
			chunkId: String(row.memory_id),
			memoryId: String(row.memory_id),
			text: String(row.text),
			hash: String(row.hash),
			rank,
			ftsRank: Number(row.fts_rank),
			score: normalizeBm25(Number(row.fts_rank))
		}))
	}

	async function semanticSearch(
		queryEmbedding: Float32Array,
		validIds: string[],
		candidateLimit: number
	): Promise<CandidateChunk[]> {
		if (validIds.length === 0 || !vectorStore) return []

		// Query Vectorize — max topK is 100 without returning values/metadata.
		// Request more than candidateLimit to absorb scope/tag post-filtering.
		const topK = Math.min(100, candidateLimit * 3)
		const matches = await vectorStore.query({ vector: queryEmbedding, topK, namespace })
		if (matches.length === 0) return []

		const matchIds = matches.map((m) => m.id)
		const scoreMap = new Map(matches.map((m) => [m.id, m.score]))
		const validSet = new Set(validIds)

		// Resolve chunk IDs → memory + text via SQLite
		const rows = await adapter.query<{
			id: unknown
			memory_id: unknown
			text: unknown
			hash: unknown
		}>(
			`SELECT c.id, c.memory_id, co.text, c.hash
			 FROM chunks c
			 JOIN memories m ON m.id = c.memory_id
			 JOIN content co ON co.hash = m.content_hash
			 WHERE c.id IN (${placeholders(matchIds.length)})`,
			matchIds
		)

		// Filter to valid memory IDs (scope/tag/path_prefix constraints) then sort by Vectorize score
		return rows
			.filter((row) => validSet.has(String(row.memory_id)))
			.map((row) => ({
				chunkId: String(row.id),
				memoryId: String(row.memory_id),
				text: String(row.text),
				hash: String(row.hash),
				score: scoreMap.get(String(row.id)) ?? 0
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, candidateLimit)
			.map((row, rank) => ({ ...row, rank, semanticScore: row.score }))
	}

	async function chunksToResults(
		candidates: CandidateChunk[],
		query: string,
		limit: number,
		options?: SearchInput['options']
	): Promise<SearchResult[]> {
		if (candidates.length === 0) return []

		const memoryIds = [...new Set(candidates.map((c) => c.memoryId))]
		if (memoryIds.length === 0) return []

		const rows = await adapter.query<{
			id: unknown
			path: unknown
			title: unknown
			created_at: unknown
			source: unknown
		}>(
			`SELECT id, path, title, created_at, source FROM memories WHERE id IN (${placeholders(memoryIds.length)})`,
			memoryIds
		)

		const memMap = new Map(rows.map((m) => [String(m.id), m]))
		const seen = new Set<string>()
		const results: SearchResult[] = []

		for (const chunk of candidates) {
			if (seen.has(chunk.memoryId)) continue
			seen.add(chunk.memoryId)

			const mem = memMap.get(chunk.memoryId)
			if (!mem) continue

			let score = chunk.score
			if (options?.temporal_decay) {
				const createdAt = mem.created_at != null ? String(mem.created_at) : null
				score = applyTemporalDecay(score, createdAt, options.decay_half_life_days ?? 30)
			}

			results.push({
				memory_id: chunk.memoryId,
				path: String(mem.path),
				title: mem.title != null ? String(mem.title) : null,
				score,
				semanticScore: chunk.semanticScore,
				ftsScore: chunk.ftsRank != null ? normalizeBm25(chunk.ftsRank) : undefined,
				rerankerScore: chunk.rerankerScore,
				snippet: generateSnippet(chunk.text, query),
				source: mem.source != null ? String(mem.source) : undefined
			})

			if (results.length >= limit) break
		}

		return results
	}

	return {
		async write(input: WriteInput): Promise<string> {
			const normalized = normalizeText(input.text)
			const hash = await sha256hex(normalized)
			const now = new Date().toISOString()
			const scope = input.scope ?? 'personal'
			const path = input.path ?? `inbox/${now.slice(0, 19).replace(/[:.]/g, '')}`
			const special = path.startsWith('*')

			let title = input.title ?? null

			const [existing] = await adapter.query<{
				id: unknown
				content_hash: unknown
				title: unknown
			}>(
				'SELECT id, content_hash, title FROM memories WHERE scope = ? AND path = ? AND active = 1 LIMIT 1',
				[scope, path]
			)

			if (existing) {
				const id = String(existing.id)
				if (String(existing.content_hash) === hash) return id

				if (!title && !special && !existing.title && llm) {
					title = (await llm.generateMetadata(normalized)).title
				}

				const oldHash = String(existing.content_hash)
				await adapter.transaction(async (tx) => {
					await tx.run('INSERT OR IGNORE INTO content(hash, text, created_at) VALUES (?, ?, ?)', [
						hash,
						normalized,
						now
					])
					await tx.run(
						`UPDATE memories SET content_hash = ?, dirty = ${special ? 0 : 1}, updated_at = ? WHERE id = ?`,
						[hash, now, id]
					)
					if (title !== null) {
						await tx.run('UPDATE memories SET title = ?, updated_at = ? WHERE id = ?', [
							title,
							now,
							id
						])
					}
					if (input.tags !== undefined) {
						await tx.run('DELETE FROM memory_tags WHERE memory_id = ?', [id])
						for (const tag of input.tags) {
							await tx.run('INSERT INTO memory_tags(memory_id, tag) VALUES (?, ?)', [id, tag])
						}
					}
					await tx.run(
						'DELETE FROM content WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM memories WHERE content_hash = ?)',
						[oldHash, oldHash]
					)
					await tx.run(
						'INSERT INTO events(id, memory_id, type, actor, at) VALUES (?, ?, ?, ?, ?)',
						[genId('evt'), id, 'write', input.source ? 'agent' : 'human', now]
					)
				})
				recentCache = null
				await notifyUpdate()
				return id
			}

			await adapter.run('INSERT OR IGNORE INTO content(hash, text, created_at) VALUES (?, ?, ?)', [
				hash,
				normalized,
				now
			])
			const memoryId = genId('mem')
			if (!title && !special && llm) {
				title = (await llm.generateMetadata(normalized)).title
			}
			await adapter.transaction(async (tx) => {
				await tx.run(
					`INSERT INTO memories(id, scope, title, content_hash, path, source, active, dirty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ${special ? 0 : 1}, ?, ?)`,
					[memoryId, scope, title, hash, path, input.source ?? null, now, now]
				)
				if (input.tags?.length) {
					for (const tag of input.tags) {
						await tx.run('INSERT INTO memory_tags(memory_id, tag) VALUES (?, ?)', [memoryId, tag])
					}
				}
				await tx.run('INSERT INTO events(id, memory_id, type, actor, at) VALUES (?, ?, ?, ?, ?)', [
					genId('evt'),
					memoryId,
					'write',
					input.source ? 'agent' : 'human',
					now
				])
			})
			recentCache = null
			await notifyUpdate()
			return memoryId
		},

		async search(input: SearchInput): Promise<SearchResult[]> {
			const scope = input.scope ?? 'personal'
			const mode = input.mode ?? 'hybrid'
			const limit = input.limit ?? 10
			let minScore = input.min_score ?? (mode !== 'exact' ? 0.1 : 0)
			const candidateLimit = limit * 4

			const validIds = await getValidMemoryIds(scope, input.filter)
			if (!validIds.length) return []

			let candidates: CandidateChunk[]
			if (mode === 'exact') {
				candidates = await exactSearch(input.query, validIds, candidateLimit)
			} else if (mode === 'semantic') {
				if (!embProvider) return []
				const [queryEmbedding] = await embProvider.embed([input.query])
				candidates = await semanticSearch(
					new Float32Array(queryEmbedding),
					validIds,
					candidateLimit
				)
			} else {
				// For CJK languages (Chinese, Japanese, Korean) words aren't space-separated,
				// so whitespace splitting always yields 1 "token" regardless of query length.
				// Instead count characters, which approximates semantic complexity well enough
				// for routing purposes (character count ≈ token count for CJK in LLM tokenizers).
				const cjk = (input.query.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
				const tokens = cjk > 0 ? cjk : input.query.trim().split(/\s+/).filter(Boolean).length
				const exact = await exactSearch(input.query, validIds, candidateLimit)

				if (tokens <= 1 || hasStrongExactSignal(exact)) {
					candidates = exact
					// FTS-only routing: BM25 scores on small corpora rarely exceed 0.3,
					// so use the same threshold as exact mode unless caller overrode it
					if (!input.min_score) minScore = 0
				} else {
					const queries =
						embProvider && llm
							? [input.query, ...(await llm.expand(input.query)).semantic]
							: [input.query]
					const semanticLists = embProvider
						? await Promise.all(
								queries.map((q) =>
									embProvider
										.embed([q])
										.then(([emb]) =>
											semanticSearch(new Float32Array(emb), validIds, candidateLimit)
										)
								)
							)
						: []
					const ftsWeight = tokens <= 2 ? 2.0 : 1.0
					const rrfWeights = [ftsWeight, ...semanticLists.map(() => 1.0)]
					candidates = rrf([exact, ...semanticLists], 60, rrfWeights)
				}

				if (reranker && candidates.length >= 2) {
					const top = candidates.slice(0, RERANK_LIMIT)
					try {
						const results = await reranker.rerank(
							input.query,
							top.map((c) => ({ id: c.chunkId, text: c.text }))
						)
						const scoreMap = new Map(results.map((r) => [r.id, r.score]))
						candidates = top
							.map((c, rank) => {
								const rerankerScore = scoreMap.get(c.chunkId)
								if (rerankerScore == null) return c
								return {
									...c,
									rerankerScore,
									score: blendWithReranker(c.score, rerankerScore, rank)
								}
							})
							.sort((a, b) => b.score - a.score)
					} catch {
						// reranker failed — keep pre-rerank order
					}
				}
			}

			return (await chunksToResults(candidates, input.query, limit, input.options)).filter(
				(r) => r.score >= minScore
			)
		},

		async update(input: UpdateInput): Promise<void> {
			const now = new Date().toISOString()

			const [mem] = await adapter.query<{
				id: unknown
				scope: unknown
				content_hash: unknown
				title: unknown
			}>(
				'SELECT id, scope, content_hash, title FROM memories WHERE id = ? AND active = 1 LIMIT 1',
				[input.id]
			)
			if (!mem) throw new Error(`Memory not found: ${input.id}`)

			let generatedTitle: string | null = null
			if (input.text !== undefined && input.title === undefined && !mem.title && llm) {
				const normalized = normalizeText(input.text)
				if (normalized.length >= 150) {
					generatedTitle = (await llm.generateMetadata(normalized)).title ?? null
				}
			}

			await adapter.transaction(async (tx) => {
				// metadata fields
				if (input.path !== undefined) {
					await tx.run('UPDATE memories SET path = ?, updated_at = ? WHERE id = ?', [
						input.path,
						now,
						input.id
					])
				}
				const titleToSet = input.title !== undefined ? input.title : generatedTitle
				if (titleToSet !== null) {
					await tx.run('UPDATE memories SET title = ?, updated_at = ? WHERE id = ?', [
						titleToSet,
						now,
						input.id
					])
				}

				// tags: full replacement
				if (input.tags !== undefined) {
					await tx.run('DELETE FROM memory_tags WHERE memory_id = ?', [input.id])
					for (const tag of input.tags) {
						await tx.run('INSERT INTO memory_tags(memory_id, tag) VALUES (?, ?)', [input.id, tag])
					}
				}

				// content: write text, defer re-chunking and re-embedding to processEmbedding()
				if (input.text !== undefined) {
					const normalized = normalizeText(input.text)
					const hash = await sha256hex(normalized)

					// insert new content (must come before UPDATE memories SET content_hash to satisfy FTS trigger)
					await tx.run('INSERT OR IGNORE INTO content(hash, text, created_at) VALUES (?, ?, ?)', [
						hash,
						normalized,
						now
					])

					await tx.run(
						'UPDATE memories SET content_hash = ?, dirty = 1, updated_at = ? WHERE id = ?',
						[hash, now, input.id]
					)

					// clean up orphaned content row
					const oldHash = String(mem.content_hash)
					await tx.run(
						'DELETE FROM content WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM memories WHERE content_hash = ?)',
						[oldHash, oldHash]
					)
				}

				await tx.run('INSERT INTO events(id, memory_id, type, actor, at) VALUES (?, ?, ?, ?, ?)', [
					genId('evt'),
					input.id,
					'update',
					input.source ? 'agent' : 'human',
					now
				])
			})
			recentCache = null
			if (input.text !== undefined) await notifyUpdate()
		},

		async archive(id: string, source?: string): Promise<void> {
			const now = new Date().toISOString()
			const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
			const [mem] = await adapter.query<{ id: unknown }>(
				'SELECT id FROM memories WHERE id = ? AND active = 1 LIMIT 1',
				[id]
			)
			if (!mem) throw new Error(`Memory not found: ${id}`)
			await adapter.transaction(async (tx) => {
				await tx.run('UPDATE memories SET active = 0, expires_at = ?, updated_at = ? WHERE id = ?', [expiresAt, now, id])
				await tx.run('INSERT INTO events(id, memory_id, type, actor, at) VALUES (?, ?, ?, ?, ?)', [
					genId('evt'),
					id,
					'archive',
					source ? 'agent' : 'human',
					now
				])
			})
			recentCache = null
			// embeddings are kept for the 30-day recovery window — purgeExpired handles cleanup
		},

		async revive(id: string, source?: string): Promise<void> {
			const now = new Date().toISOString()
			const [mem] = await adapter.query<{ id: unknown; content_hash: unknown }>(
				'SELECT id, content_hash FROM memories WHERE id = ? AND active = 0 LIMIT 1',
				[id]
			)
			if (!mem) throw new Error(`Archived memory not found: ${id}`)
			const contentHash = String(mem.content_hash)
			await adapter.transaction(async (tx) => {
				await tx.run('UPDATE memories SET active = 1, expires_at = NULL, updated_at = ? WHERE id = ?', [now, id])
				// FTS trigger only fires on active=0; re-insert manually on restore
				await tx.run('DELETE FROM memory_fts WHERE memory_id = ?', [id])
				await tx.run(
					'INSERT INTO memory_fts (memory_id, text) SELECT ?, text FROM content WHERE hash = ?',
					[id, contentHash]
				)
				await tx.run('INSERT INTO events(id, memory_id, type, actor, at) VALUES (?, ?, ?, ?, ?)', [
					genId('evt'),
					id,
					'revive',
					source ? 'agent' : 'human',
					now
				])
			})
			recentCache = null
		},

		async purge(id: string): Promise<void> {
			const [mem] = await adapter.query<{ id: unknown; content_hash: unknown }>(
				'SELECT id, content_hash FROM memories WHERE id = ? LIMIT 1',
				[id]
			)
			if (!mem) throw new Error(`Memory not found: ${id}`)
			const contentHash = String(mem.content_hash)
			const chunkRows = await adapter.query<{ id: unknown }>(
				'SELECT id FROM chunks WHERE memory_id = ?',
				[id]
			)
			await adapter.transaction(async (tx) => {
				await tx.run('DELETE FROM memory_tags WHERE memory_id = ?', [id])
				await tx.run('DELETE FROM memory_links WHERE from_id = ? OR to_id = ?', [id, id])
				await tx.run('DELETE FROM chunks WHERE memory_id = ?', [id])
				await tx.run('DELETE FROM events WHERE memory_id = ?', [id])
				await tx.run('DELETE FROM memories WHERE id = ?', [id])
				await tx.run(
					'DELETE FROM content WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM memories WHERE content_hash = ?)',
					[contentHash, contentHash]
				)
			})
			if (vectorStore && chunkRows.length > 0) {
				await vectorStore.delete(chunkRows.map((r) => String(r.id)))
			}
			recentCache = null
		},

		async purgeExpired(): Promise<void> {
			const now = new Date().toISOString()
			const expired = await adapter.query<{ id: unknown }>(
				"SELECT id FROM memories WHERE active = 0 AND expires_at IS NOT NULL AND expires_at <= ? LIMIT 50",
				[now]
			)
			for (const row of expired) {
				const id = String(row.id)
				try {
					const [mem] = await adapter.query<{ id: unknown; content_hash: unknown }>(
						'SELECT id, content_hash FROM memories WHERE id = ? LIMIT 1',
						[id]
					)
					if (!mem) continue
					const contentHash = String(mem.content_hash)
					const chunkRows = await adapter.query<{ id: unknown }>(
						'SELECT id FROM chunks WHERE memory_id = ?',
						[id]
					)
					await adapter.transaction(async (tx) => {
						await tx.run('DELETE FROM memory_tags WHERE memory_id = ?', [id])
						await tx.run('DELETE FROM memory_links WHERE from_id = ? OR to_id = ?', [id, id])
						await tx.run('DELETE FROM chunks WHERE memory_id = ?', [id])
						await tx.run('DELETE FROM events WHERE memory_id = ?', [id])
						await tx.run('DELETE FROM memories WHERE id = ?', [id])
						await tx.run(
							'DELETE FROM content WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM memories WHERE content_hash = ?)',
							[contentHash, contentHash]
						)
					})
					if (vectorStore && chunkRows.length > 0) {
						await vectorStore.delete(chunkRows.map((r) => String(r.id)))
					}
				} catch (e) {
					console.error(`purgeExpired: failed to purge ${id}:`, e)
				}
			}
			recentCache = null
		},

		async list(input: ListInput): Promise<ListResult[]> {
			const limit = input.limit ?? 50
			const tags = normalizeTags(input.tags)
			const conditions: string[] = [input.archived ? 'm.active = 0' : 'm.active = 1', "m.path NOT LIKE '*%'"]
			const params: SqlValue[] = []

			if (input.created?.after) {
				conditions.push('m.created_at >= ?')
				params.push(input.created.after)
			}
			if (input.created?.before) {
				conditions.push('m.created_at <= ?')
				params.push(input.created.before)
			}
			if (input.updated?.after) {
				conditions.push('m.updated_at >= ?')
				params.push(input.updated.after)
			}
			if (input.updated?.before) {
				conditions.push('m.updated_at <= ?')
				params.push(input.updated.before)
			}

			if (input.path_prefix) {
				conditions.push('m.path LIKE ?')
				params.push(`${input.path_prefix}%`)
			} else if (input.path_pattern) {
				// Translate glob pattern to SQL LIKE: ** → %, * → %
				const likePattern = input.path_pattern
					.replace(/\*\*/g, '\x00')
					.replace(/\*/g, '%')
					.replace(/\x00/g, '%')
				conditions.push('m.path LIKE ?')
				params.push(likePattern)
			}

			let sql = 'SELECT DISTINCT m.id, m.path, m.title, m.source FROM memories m'
			if (tags.length > 0) {
				sql += ' JOIN memory_tags mt ON mt.memory_id = m.id'
				conditions.push(`mt.tag IN (${placeholders(tags.length)})`)
				params.push(...tags)
			}
			sql += ` WHERE ${conditions.join(' AND ')} ORDER BY m.created_at DESC LIMIT ?`
			params.push(limit)

			const rows = await adapter.query<{
				id: unknown
				path: unknown
				title: unknown
				source: unknown
			}>(sql, params)

			if (rows.length === 0) return []

			const ids = rows.map((r) => String(r.id))
			const tagRows = await adapter.query<{ memory_id: unknown; tag: unknown }>(
				`SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${placeholders(ids.length)})`,
				ids
			)
			const tagMap = new Map<string, string[]>()
			for (const t of tagRows) {
				const mid = String(t.memory_id)
				if (!tagMap.has(mid)) tagMap.set(mid, [])
				tagMap.get(mid)!.push(String(t.tag))
			}

			return rows.map((r) => ({
				id: String(r.id),
				path: String(r.path),
				title: r.title != null ? String(r.title) : null,
				tags: tagMap.get(String(r.id)) ?? [],
				source: r.source != null ? String(r.source) : null
			}))
		},

		async get(id: string): Promise<Memory | null> {
			const [memory] = await adapter.query<{
				id: unknown
				scope: unknown
				title: unknown
				path: unknown
				source: unknown
				content_hash: unknown
				created_at: unknown
				updated_at: unknown
				active: unknown
			}>('SELECT * FROM memories WHERE id = ? LIMIT 1', [id])

			if (!memory) return null

			const [tags, outgoing, incoming, contentRows] = await Promise.all([
				adapter.query<{ tag: unknown }>('SELECT tag FROM memory_tags WHERE memory_id = ?', [id]),
				adapter.query<{ to_id: unknown; rel_type: unknown; reason: unknown; created_at: unknown }>(
					'SELECT to_id, rel_type, reason, created_at FROM memory_links WHERE from_id = ?',
					[id]
				),
				adapter.query<{
					from_id: unknown
					rel_type: unknown
					reason: unknown
					created_at: unknown
				}>('SELECT from_id, rel_type, reason, created_at FROM memory_links WHERE to_id = ?', [id]),
				adapter.query<{ text: unknown }>('SELECT text FROM content WHERE hash = ?', [
					String(memory.content_hash)
				])
			])

			await adapter.run(
				'UPDATE memories SET last_retrieved_at = ?, retrieval_count = COALESCE(retrieval_count, 0) + 1 WHERE id = ?',
				[new Date().toISOString(), id]
			)

			return {
				id: String(memory.id),
				scope: String(memory.scope),
				title: memory.title != null ? String(memory.title) : null,
				raw_text: String(contentRows[0]?.text ?? ''),
				path: String(memory.path),
				source: memory.source != null ? String(memory.source) : null,
				created_at: String(memory.created_at),
				updated_at: String(memory.updated_at),
				active: Number(memory.active),
				tags: tags.map((t) => String(t.tag)),
				links: [
					...outgoing.map((l) => ({
						to_id: String(l.to_id),
						rel_type: String(l.rel_type),
						reason: l.reason != null ? String(l.reason) : null,
						created_at: String(l.created_at)
					})),
					...incoming.map((l) => ({
						from_id: String(l.from_id),
						rel_type: String(l.rel_type),
						reason: l.reason != null ? String(l.reason) : null,
						created_at: String(l.created_at)
					}))
				]
			}
		},

		async findByPath(path: string): Promise<{ id: string; raw_text: string } | null> {
			const [row] = await adapter.query<{ id: unknown; text: unknown }>(
				`SELECT m.id, c.text FROM memories m JOIN content c ON c.hash = m.content_hash WHERE m.path = ? AND m.active = 1 LIMIT 1`,
				[path]
			)
			return row ? { id: String(row.id), raw_text: String(row.text) } : null
		},

		async recent(n: number): Promise<RecentResult[]> {
			const MAX_CACHE = 20
			if (!recentCache) {
				const rows = await adapter.query<{
					id: unknown
					path: unknown
					title: unknown
					updated_at: unknown
				}>(
					`SELECT id, path, title, updated_at FROM memories WHERE active = 1 AND path NOT LIKE '*%' ORDER BY updated_at DESC LIMIT ?`,
					[MAX_CACHE]
				)
				if (rows.length === 0) {
					recentCache = []
				} else {
					const ids = rows.map((r) => String(r.id))
					const tagRows = await adapter.query<{ memory_id: unknown; tag: unknown }>(
						`SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${placeholders(ids.length)})`,
						ids
					)
					const tagMap = new Map<string, string[]>()
					for (const t of tagRows) {
						const mid = String(t.memory_id)
						if (!tagMap.has(mid)) tagMap.set(mid, [])
						tagMap.get(mid)!.push(String(t.tag))
					}
					recentCache = rows.map((r) => ({
						id: String(r.id),
						path: String(r.path),
						title: r.title != null ? String(r.title) : null,
						tags: tagMap.get(String(r.id)) ?? [],
						updated_at: String(r.updated_at)
					}))
				}
			}
			return recentCache.slice(0, n)
		},

		async changes(since: string): Promise<ChangesResult> {
			const rows = await adapter.query<{ id: unknown; title: unknown; path: unknown; updated_at: unknown; active: unknown }>(
				`SELECT id, title, path, updated_at, active FROM memories WHERE updated_at > ? AND path NOT LIKE '*%'`,
				[since]
			)

			if (rows.length === 0) return { upserted: [] }

			const ids = rows.map((r) => String(r.id))
			const tagRows = await adapter.query<{ memory_id: unknown; tag: unknown }>(
				`SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${placeholders(ids.length)})`,
				ids
			)
			const tagMap = new Map<string, string[]>()
			for (const t of tagRows) {
				const mid = String(t.memory_id)
				if (!tagMap.has(mid)) tagMap.set(mid, [])
				tagMap.get(mid)!.push(String(t.tag))
			}

			return {
				upserted: rows.map((r) => ({
					id: String(r.id),
					title: r.title != null ? String(r.title) : null,
					path: String(r.path),
					updated_at: String(r.updated_at),
					active: Number(r.active),
					tags: tagMap.get(String(r.id)) ?? [],
				})),
			}
		},

		async link(input: LinkInput): Promise<void> {
			const now = new Date().toISOString()
			const [from] = await adapter.query<{ id: unknown }>(
				'SELECT id FROM memories WHERE id = ? AND active = 1 LIMIT 1',
				[input.from_id]
			)
			if (!from) throw new Error(`Memory not found: ${input.from_id}`)
			const [to] = await adapter.query<{ id: unknown }>(
				'SELECT id FROM memories WHERE id = ? AND active = 1 LIMIT 1',
				[input.to_id]
			)
			if (!to) throw new Error(`Memory not found: ${input.to_id}`)
			await adapter.transaction(async (tx) => {
				await tx.run(
					`INSERT INTO memory_links(from_id, to_id, rel_type, actor_type, actor_name, reason, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(from_id, to_id, rel_type) DO NOTHING`,
					[
						input.from_id,
						input.to_id,
						input.rel_type,
						input.source ? 'agent' : 'human',
						input.source ?? null,
						input.reason ?? null,
						now
					]
				)
				await tx.run('INSERT INTO events(id, memory_id, type, actor, at) VALUES (?, ?, ?, ?, ?)', [
					genId('evt'),
					input.from_id,
					'link',
					input.source ? 'agent' : 'human',
					now
				])
			})
		},

		onUpdate(action: () => void | Promise<void>): void {
			updateListeners.push(action)
		},

		async processEmbedding(): Promise<boolean> {
			const BATCH = 10
			const dirtyMems = await adapter.query<{
				id: unknown
				content_hash: unknown
				title: unknown
			}>(
				`SELECT id, content_hash, title FROM memories WHERE dirty = 1 AND active = 1 AND path NOT LIKE '*%' ORDER BY updated_at ASC LIMIT ${BATCH + 1}`
			)
			if (dirtyMems.length === 0) return false
			const hasMore = dirtyMems.length > BATCH
			const batch = dirtyMems.slice(0, BATCH)

			for (const mem of batch) {
				const memId = String(mem.id)
				const contentHash = String(mem.content_hash)
				const existingTitle = mem.title != null ? String(mem.title) : null

				const [contentRow] = await adapter.query<{ text: unknown }>(
					'SELECT text FROM content WHERE hash = ?',
					[contentHash]
				)
				if (!contentRow) {
					await adapter.run('UPDATE memories SET dirty = 0 WHERE id = ?', [memId])
					continue
				}
				const text = String(contentRow.text)
				let newTitle: string | null = null
				if (!existingTitle && llm) {
					newTitle = (await llm.generateMetadata(text)).title ?? null
				}

				if (embProvider) {
					const newChunks = chunkText(text)
					const newHashes = await Promise.all(newChunks.map((c) => sha256hex(c.text)))

					// Load existing chunks for this memory
					const oldRows = await adapter.query<{
						id: unknown
						seq: unknown
						pos: unknown
						len: unknown
						token_count: unknown
						hash: unknown
					}>('SELECT id, seq, pos, len, token_count, hash FROM chunks WHERE memory_id = ?', [memId])

					// Build a pool per hash to handle duplicate chunks within one document
					const oldPool = new Map<string, typeof oldRows>()
					for (const row of oldRows) {
						const h = String(row.hash)
						if (!oldPool.has(h)) oldPool.set(h, [])
						oldPool.get(h)!.push(row)
					}

					// Greedily claim one old chunk per new chunk with the same hash
					const reused = new Map<number, (typeof oldRows)[0]>() // newChunk index → old row
					const claimedIds = new Set<string>()
					for (let i = 0; i < newChunks.length; i++) {
						const pool = oldPool.get(newHashes[i])
						if (pool?.length) {
							const row = pool.shift()!
							reused.set(i, row)
							claimedIds.add(String(row.id))
						}
					}

					const toDelete = oldRows.filter((r) => !claimedIds.has(String(r.id)))
					const toAdd = newChunks.map((_, i) => i).filter((i) => !reused.has(i))

					// Embed all added chunks, deduplicated by hash within this batch
					const embeddings = new Map<string, Float32Array>()
					if (toAdd.length > 0) {
						const hashToText = new Map<string, string>()
						for (const i of toAdd) hashToText.set(newHashes[i], newChunks[i].text)
						const hashes = [...hashToText.keys()]
						const fresh = await embProvider.embed(hashes.map((h) => hashToText.get(h)!))
						hashes.forEach((h, j) => embeddings.set(h, new Float32Array(fresh[j])))
					}

					// Collect Vectorize operations; apply after SQLite transaction succeeds
					const idsToDelete = toDelete.map((r) => String(r.id))
					const vectorsToUpsert: Array<{ id: string; values: Float32Array }> = []

					const now = new Date().toISOString()
					await adapter.transaction(async (tx) => {
						// Delete removed chunks
						for (const row of toDelete) {
							await tx.run('DELETE FROM chunks WHERE id = ?', [String(row.id)])
						}

						// Update position metadata for reused chunks if it shifted
						for (const [i, row] of reused) {
							const c = newChunks[i]
							if (
								Number(row.seq) !== c.seq ||
								Number(row.pos) !== c.pos ||
								Number(row.len) !== c.len
							) {
								await tx.run(
									'UPDATE chunks SET seq = ?, pos = ?, len = ?, token_count = ? WHERE id = ?',
									[c.seq, c.pos, c.len, c.tokenCount, String(row.id)]
								)
							}
						}

						// Insert new chunks
						for (const i of toAdd) {
							const c = newChunks[i]
							const chunkId = genId('chk')
							await tx.run(
								'INSERT INTO chunks(id, memory_id, seq, pos, len, token_count, hash, embedding_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
								[chunkId, memId, c.seq, c.pos, c.len, c.tokenCount, newHashes[i], embModelKey, now]
							)
							const emb = embeddings.get(newHashes[i])
							if (emb) vectorsToUpsert.push({ id: chunkId, values: emb })
						}

						if (newTitle) {
							await tx.run(
								'UPDATE memories SET dirty = 0, title = ?, updated_at = ? WHERE id = ?',
								[newTitle, now, memId]
							)
						} else {
							await tx.run('UPDATE memories SET dirty = 0 WHERE id = ?', [memId])
						}
					})

					// Sync with Vectorize after SQLite transaction succeeds
					if (vectorStore) {
						if (idsToDelete.length > 0) await vectorStore.delete(idsToDelete)
						if (vectorsToUpsert.length > 0) {
								await vectorStore.upsert(
								vectorsToUpsert.map((v) => ({ id: v.id, values: v.values, namespace }))
							)
						}
					}
				} else if (newTitle) {
					const now = new Date().toISOString()
					await adapter.run(
						'UPDATE memories SET dirty = 0, title = ?, updated_at = ? WHERE id = ?',
						[newTitle, now, memId]
					)
				} else {
					await adapter.run('UPDATE memories SET dirty = 0 WHERE id = ?', [memId])
				}
			}

			return hasMore
		}
	}
}

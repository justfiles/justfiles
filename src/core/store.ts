import { z } from 'zod'
import type { EmbeddingProvider } from './embedding'
import type { LLM } from './llm'
import type { Reranker } from './reranker'
import type { DbAdapter, SqlValue } from './db'

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

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	const len = Math.min(a.length, b.length)
	if (len === 0) return 0

	let dot = 0
	let aNorm = 0
	let bNorm = 0

	for (let i = 0; i < len; i++) {
		const av = a[i]
		const bv = b[i]
		dot += av * bv
		aNorm += av * av
		bNorm += bv * bv
	}

	if (!aNorm || !bNorm) return 0
	return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm))
}

function applyTemporalDecay(score: number, occurredAt: string | null, halfLifeDays: number): number {
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

function rrf(lists: CandidateChunk[][], k = 60): CandidateChunk[] {
	const scores = new Map<string, { chunk: CandidateChunk; rrfScore: number }>()
	for (const list of lists) {
		for (let rank = 0; rank < list.length; rank++) {
			const chunk = list[rank]
			const add = 1 / (k + rank + 1)
			const prev = scores.get(chunk.chunkId)
			const merged: CandidateChunk = {
				...(prev?.chunk ?? chunk),
				semanticScore: chunk.semanticScore ?? prev?.chunk.semanticScore,
				ftsRank: chunk.ftsRank ?? prev?.chunk.ftsRank
			}
			scores.set(chunk.chunkId, { chunk: merged, rrfScore: (prev?.rrfScore ?? 0) + add })
		}
	}
	const TOP_RANK_BONUS = [0.05, 0.02, 0.02]
	return Array.from(scores.values())
		.sort((a, b) => b.rrfScore - a.rrfScore)
		.map((v, i) => {
			const { chunk } = v
			const ftsScore = chunk.ftsRank != null ? normalizeBm25(chunk.ftsRank) : 0
			const base = Math.max(chunk.semanticScore ?? 0, ftsScore)
			const score = Math.min(1, base + (TOP_RANK_BONUS[i] ?? 0))
			return { ...chunk, score }
		})
}

// ---- Utils ----

type RawEmbedding = Uint8Array | ArrayBuffer

interface TextChunk {
	seq: number
	text: string
	pos: number
	len: number
	tokenCount: number
}

function toFloat32Array(value: RawEmbedding | null): Float32Array {
	if (!value) return new Float32Array(0)
	if (value instanceof Float32Array) return value
	if (value instanceof ArrayBuffer) return new Float32Array(value)
	return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
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
	return Math.ceil(text.length / 4)
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

function encodeEmbedding(values: number[]): Uint8Array {
	return new Uint8Array(new Float32Array(values).buffer)
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

export type RecentResult = {
	id: string
	path: string
	title: string | null
	tags: string[]
	updated_at: string
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
	 * get a memory by id, returns null if not found
	 */
	get(id: string): Promise<Memory | null>

	/**
	 * get N most recently updated active memories, cached in-memory and invalidated on capture/update
	 */
	recent(n: number): Promise<RecentResult[]>
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
	embProvider?: EmbeddingProvider,
	llm?: LLM,
	reranker?: Reranker
): Store {
	const embModelKey = embProvider ? `${embProvider.provider}:${embProvider.model}` : 'none'
	let recentCache: RecentResult[] | null = null

	async function getValidMemoryIds(
		scope: string,
		filter?: SearchInput['filter']
	): Promise<string[]> {
		const tags = normalizeTags(filter?.fields?.tags)
		const conditions = ['m.scope = ?', 'm.active = 1']
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
		if (validIds.length === 0 || !embProvider) return []

		const rows = await adapter.query<{
			id: unknown
			memory_id: unknown
			text: unknown
			hash: unknown
			embedding: unknown
		}>(
			`SELECT c.id, c.memory_id, co.text, c.hash, cv.embedding
			 FROM chunks c
			 JOIN chunk_vectors cv ON cv.chunk_id = c.id
			 JOIN memories m ON m.id = c.memory_id
			 JOIN content co ON co.hash = m.content_hash
			 WHERE cv.provider = ?
			 AND cv.model = ?
			 AND c.memory_id IN (${placeholders(validIds.length)})`,
			[embProvider.provider, embProvider.model, ...validIds]
		)

		const scored = rows
			.map((row) => ({
				chunkId: String(row.id),
				memoryId: String(row.memory_id),
				text: String(row.text),
				hash: String(row.hash),
				score: cosineSimilarity(
					queryEmbedding,
					toFloat32Array(row.embedding as RawEmbedding | null)
				)
			}))
			.sort((a, b) => b.score - a.score)

		return scored
			.filter((row) => Number.isFinite(row.score))
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

	async function getCachedEmbeddings(chunkHashes: string[]): Promise<Map<string, Float32Array>> {
		if (!embProvider || chunkHashes.length === 0) return new Map()

		const rows = await adapter.query<{ hash: unknown; embedding: unknown }>(
			`SELECT c.hash, cv.embedding FROM chunk_vectors cv
			 JOIN chunks c ON c.id = cv.chunk_id
			 WHERE cv.provider = ? AND cv.model = ? AND c.hash IN (${placeholders(chunkHashes.length)})`,
			[embProvider.provider, embProvider.model, ...chunkHashes]
		)

		return new Map(
			rows.map((row) => [String(row.hash), toFloat32Array(row.embedding as RawEmbedding | null)])
		)
	}

	return {
		async capture(input: CaptureInput): Promise<string> {
			const normalized = normalizeText(input.text)
			const hash = await sha256hex(normalized)
			const now = new Date().toISOString()
			const scope = input.scope ?? 'personal'

			const [existing] = await adapter.query<{ id: unknown }>(
				'SELECT id FROM memories WHERE content_hash = ? AND active = 1 LIMIT 1',
				[hash]
			)
			if (existing) return String(existing.id)

			const meta =
				llm && input.title === undefined
					? await llm.generateMetadata(normalized).catch(() => null)
					: null

			const path = input.path ?? `inbox/${now.slice(0, 19).replace(/[:.]/g, '')}`
			let oldPathMemoryId: string | null = null

			if (input.path) {
				const [old] = await adapter.query<{ id: unknown }>(
					'SELECT id FROM memories WHERE scope = ? AND path = ? AND active = 1 LIMIT 1',
					[scope, input.path]
				)
				if (old) oldPathMemoryId = String(old.id)
			}

			const chunks = chunkText(normalized)
			const chunkHashes = await Promise.all(chunks.map((c) => sha256hex(c.text)))

			const chunkEmbeddings: Array<Float32Array | null> = chunks.map(() => null)

			await adapter.run('INSERT OR IGNORE INTO content(hash, text, created_at) VALUES (?, ?, ?)', [
				hash,
				normalized,
				now
			])

			if (embProvider) {
				const cached = await getCachedEmbeddings(chunkHashes)
				const missingIndexes: number[] = []
				for (let i = 0; i < chunks.length; i++) {
					const cachedVec = cached.get(chunkHashes[i])
					if (cachedVec) chunkEmbeddings[i] = cachedVec
					else missingIndexes.push(i)
				}

				if (missingIndexes.length > 0) {
					const missingTexts = missingIndexes.map((i) => chunks[i].text)
					const fresh = await embProvider.embed(missingTexts)

					for (let i = 0; i < missingIndexes.length; i++) {
						const chunkIndex = missingIndexes[i]
						const vector = new Float32Array(fresh[i])
						chunkEmbeddings[chunkIndex] = vector
					}
				}
			}

			const memoryId = genId('mem')

			await adapter.transaction(async (tx) => {
				if (oldPathMemoryId) {
					await tx.run('UPDATE memories SET active = 0, updated_at = ? WHERE id = ?', [
						now,
						oldPathMemoryId
					])
					await tx.run(
						'INSERT INTO events(id, memory_id, type, actor, at) VALUES (?, ?, ?, ?, ?)',
						[genId('evt'), oldPathMemoryId, 'archive', input.source ? 'agent' : 'system', now]
					)
				}

				await tx.run(
					'INSERT INTO memories(id, scope, title, content_hash, path, source, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
					[
						memoryId,
						scope,
						input.title ?? meta?.title ?? null,
						hash,
						path,
						input.source ?? null,
						now,
						now
					]
				)

				const effectiveTags = input.tags?.length ? input.tags : (meta?.tags ?? [])
				if (effectiveTags.length) {
					for (const tag of effectiveTags) {
						await tx.run('INSERT INTO memory_tags(memory_id, tag) VALUES (?, ?)', [memoryId, tag])
					}
				}

				for (let i = 0; i < chunks.length; i++) {
					const chunk = chunks[i]
					const chunkId = genId('chk')

					await tx.run(
						'INSERT INTO chunks(id, memory_id, seq, pos, len, token_count, hash, embedding_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
						[
							chunkId,
							memoryId,
							chunk.seq,
							chunk.pos,
							chunk.len,
							chunk.tokenCount,
							chunkHashes[i],
							embModelKey,
							now
						]
					)

					const embedding = chunkEmbeddings[i]
					if (embedding) {
						await tx.run(
							'INSERT INTO chunk_vectors(chunk_id, provider, model, dims, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
							[
								chunkId,
								embProvider?.provider ?? 'none',
								embProvider?.model ?? 'none',
								embedding.length,
								encodeEmbedding(Array.from(embedding)),
								now
							]
						)
					}
				}

				await tx.run('INSERT INTO events(id, memory_id, type, actor, at) VALUES (?, ?, ?, ?, ?)', [
					genId('evt'),
					memoryId,
					'capture',
					input.source ? 'agent' : 'human',
					now
				])
			})

			recentCache = null
			return memoryId
		},

		async search(input: SearchInput): Promise<SearchResult[]> {
			const scope = input.scope ?? 'personal'
			const mode = input.mode ?? 'hybrid'
			const limit = input.limit ?? 10
			const minScore = input.min_score ?? (mode !== 'exact' ? 0.3 : 0)
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
				const exact = await exactSearch(input.query, validIds, candidateLimit)
				const queries =
					embProvider && llm && !hasStrongExactSignal(exact)
						? [input.query, ...(await llm.expand(input.query)).semantic]
						: [input.query]
				const semanticLists = embProvider
					? await Promise.all(
							queries.map((q) =>
								embProvider
									.embed([q])
									.then(([emb]) => semanticSearch(new Float32Array(emb), validIds, candidateLimit))
							)
						)
					: []
				candidates = rrf([exact, ...semanticLists])

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

			const [mem] = await adapter.query<{ id: unknown; scope: unknown; content_hash: unknown }>(
				'SELECT id, scope, content_hash FROM memories WHERE id = ? AND active = 1 LIMIT 1',
				[input.id]
			)
			if (!mem) throw new Error(`Memory not found: ${input.id}`)

			await adapter.transaction(async (tx) => {
				// metadata fields
				if (input.path !== undefined) {
					await tx.run('UPDATE memories SET path = ?, updated_at = ? WHERE id = ?', [
						input.path,
						now,
						input.id
					])
				}
				if (input.title !== undefined) {
					await tx.run('UPDATE memories SET title = ?, updated_at = ? WHERE id = ?', [
						input.title,
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

				// content: rechunk and re-embed
				if (input.text !== undefined) {
					const normalized = normalizeText(input.text)
					const hash = await sha256hex(normalized)
					const chunks = chunkText(normalized)
					const chunkHashes = await Promise.all(chunks.map((c) => sha256hex(c.text)))

					const chunkEmbeddings: Array<Float32Array | null> = chunks.map(() => null)
					if (embProvider) {
						const cached = await getCachedEmbeddings(chunkHashes)
						const missingIndexes: number[] = []
						for (let i = 0; i < chunks.length; i++) {
							const cachedVec = cached.get(chunkHashes[i])
							if (cachedVec) chunkEmbeddings[i] = cachedVec
							else missingIndexes.push(i)
						}
						if (missingIndexes.length > 0) {
							const fresh = await embProvider.embed(missingIndexes.map((i) => chunks[i].text))
							for (let i = 0; i < missingIndexes.length; i++) {
								const chunkIndex = missingIndexes[i]
								const vector = new Float32Array(fresh[i])
								chunkEmbeddings[chunkIndex] = vector
							}
						}
					}

					// insert new content (must come before UPDATE memories SET content_hash to satisfy FTS trigger)
					await tx.run('INSERT OR IGNORE INTO content(hash, text, created_at) VALUES (?, ?, ?)', [
						hash,
						normalized,
						now
					])

					// delete chunk_vectors first (FK → chunks), then chunks (FTS triggers handle FTS cleanup)
					await tx.run(
						'DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE memory_id = ?)',
						[input.id]
					)
					await tx.run('DELETE FROM chunks WHERE memory_id = ?', [input.id])

					// insert new chunks
					for (let i = 0; i < chunks.length; i++) {
						const chunk = chunks[i]
						const chunkId = genId('chk')
						await tx.run(
							'INSERT INTO chunks(id, memory_id, seq, pos, len, token_count, hash, embedding_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
							[
								chunkId,
								input.id,
								chunk.seq,
								chunk.pos,
								chunk.len,
								chunk.tokenCount,
								chunkHashes[i],
								embModelKey,
								now
							]
						)
						const embedding = chunkEmbeddings[i]
						if (embedding) {
							await tx.run(
								'INSERT INTO chunk_vectors(chunk_id, provider, model, dims, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
								[
									chunkId,
									embProvider?.provider ?? 'none',
									embProvider?.model ?? 'none',
									embedding.length,
									encodeEmbedding(Array.from(embedding)),
									now
								]
							)
						}
					}

					await tx.run('UPDATE memories SET content_hash = ?, updated_at = ? WHERE id = ?', [
						hash,
						now,
						input.id
					])

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
		},

		async list(input: ListInput): Promise<ListResult[]> {
			const limit = input.limit ?? 50
			const tags = normalizeTags(input.tags)
			const conditions: string[] = ['m.active = 1']
			const params: SqlValue[] = []

			if (input.path_prefix) {
				conditions.push('m.path LIKE ?')
				params.push(`${input.path_prefix}%`)
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
			}>('SELECT * FROM memories WHERE id = ? AND active = 1 LIMIT 1', [id])

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

		async recent(n: number): Promise<RecentResult[]> {
			const MAX_CACHE = 20
			if (!recentCache) {
				const rows = await adapter.query<{
					id: unknown
					path: unknown
					title: unknown
					updated_at: unknown
				}>(
					`SELECT id, path, title, updated_at FROM memories WHERE active = 1 ORDER BY updated_at DESC LIMIT ?`,
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
		}
	}
}

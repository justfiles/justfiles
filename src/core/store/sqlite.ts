import { Database } from 'bun:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EmbeddingProvider } from '../embedding'
import type { CaptureInput, Memory, SearchInput, SearchResult, Store } from './types'
import { applyTemporalDecay, cosineSimilarity, normalizeBm25, rrf, type CandidateChunk } from './scoring'
import type { QueryExpander } from '../llm'

type RawEmbedding = Buffer | Uint8Array | ArrayBuffer

function toFloat32Array(value: RawEmbedding | null): Float32Array {
	if (!value) return new Float32Array(0)
	if (value instanceof Float32Array) return value
	if (value instanceof ArrayBuffer) return new Float32Array(value)
	return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
}

interface TextChunk {
	seq: number
	text: string
	startLine: number
	endLine: number
	tokenCount: number
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
				startLine,
				endLine: startLine + chunkLines.length - 1,
				tokenCount: approxTokens(chunkTextContent)
			})
		}
	}

	return chunks
}

function generateSnippet(text: string, query: string, maxLen = 200): string {
	const firstTerm = query.split(/\s+/)[0]?.toLowerCase() ?? ''
	const idx = firstTerm ? text.toLowerCase().indexOf(firstTerm) : -1
	const start = Math.max(0, idx === -1 ? 0 : idx - 60)
	const end = Math.min(text.length, start + maxLen)
	const snippet = text.slice(start, end)
	return `${start > 0 ? '…' : ''}${snippet}${end < text.length ? '…' : ''}`
}

function encodeEmbedding(values: number[]): Buffer {
	return Buffer.from(new Float32Array(values).buffer)
}


function placeholders(count: number): string {
	return Array.from({ length: count }, () => '?').join(',')
}

function normalizeTags(tags?: string | string[]): string[] {
	if (!tags) return []
	return Array.isArray(tags) ? tags.filter(Boolean) : [tags]
}

// ---- Migration ----

function migrate(db: Database): void {
	const versionRow = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
	const currentVersion = Number(versionRow?.user_version ?? 0)
	const migrationDir = fileURLToPath(new URL('./migrations', import.meta.url))
	const migrationFiles = readdirSync(migrationDir)
		.filter((name) => /^\d{4}_.*\.sql$/.test(name))
		.sort()

	for (const file of migrationFiles) {
		const version = parseInt(file.slice(0, 4), 10)
		if (version <= currentVersion) continue

		const fullPath = `${migrationDir}${sep}${file}`
		const sql = readFileSync(fullPath, 'utf8')
		db.exec(sql)
		db.exec(`PRAGMA user_version = ${version}`)
	}
}

// ---- Store Implementation ----

const STRONG_SIGNAL_MIN_SCORE = 0.85
const STRONG_SIGNAL_MIN_GAP = 0.15

function hasStrongExactSignal(exact: CandidateChunk[]): boolean {
	if (exact.length === 0) return false
	const top = exact[0].score
	if (top < STRONG_SIGNAL_MIN_SCORE) return false
	const second = exact[1]?.score ?? 0
	return top - second >= STRONG_SIGNAL_MIN_GAP
}

export function sqliteStore(dbPath: string, embProvider?: EmbeddingProvider, queryExpander?: QueryExpander): Store {
	const absDbPath = resolve(dbPath)
	const db = new Database(absDbPath)
	db.exec('PRAGMA foreign_keys = ON')
	db.exec('PRAGMA journal_mode = WAL')
	migrate(db)

	const embModelKey = embProvider ? `${embProvider.provider}:${embProvider.model}` : 'none'

	function getValidMemoryIds(scope: string, filter?: SearchInput['filter']): string[] {
		const tags = normalizeTags(filter?.fields?.tags)
		const conditions = ['m.scope = ?', 'm.active = 1']
		const params: string[] = [scope]

		if (filter?.occurred_after) {
			conditions.push('m.occurred_at >= ?')
			params.push(filter.occurred_after)
		}

		if (filter?.occurred_before) {
			conditions.push('m.occurred_at <= ?')
			params.push(filter.occurred_before)
		}

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

		const rows = db.prepare(sql).all(...params) as Array<{ id: string }>
		return rows.map((row) => row.id)
	}

	function exactSearch(query: string, validIds: string[], candidateLimit: number): CandidateChunk[] {
		if (validIds.length === 0) return []

		const rows = db
			.prepare(
				`SELECT c.id, c.memory_id, c.text, c.hash, f.rank as fts_rank
				 FROM chunks_fts f
				 JOIN chunks c ON c.id = f.chunk_id
				 WHERE f.text MATCH ?
				 AND c.memory_id IN (${placeholders(validIds.length)})
				 ORDER BY f.rank
				 LIMIT ?`
			)
			.all(query, ...validIds, candidateLimit) as Array<{
			id: string
			memory_id: string
			text: string
			hash: string
			fts_rank: number
		}>

		// FTS5 rank is negative BM25; 1 - exp(rank) maps to (0,1] where better matches → 1
		return rows.map((row, rank) => ({
			chunkId: row.id,
			memoryId: row.memory_id,
			text: row.text,
			hash: row.hash,
			rank,
			ftsRank: row.fts_rank,
			score: normalizeBm25(row.fts_rank)
		}))
	}

	function semanticSearch(
		queryEmbedding: Float32Array,
		validIds: string[],
		candidateLimit: number
	): CandidateChunk[] {
		if (validIds.length === 0 || !embProvider) return []

		const rows = db
			.prepare(
				`SELECT c.id, c.memory_id, c.text, c.hash, cv.embedding, cv.dims
				 FROM chunks c
				 JOIN chunk_vectors cv ON cv.chunk_id = c.id
				 WHERE cv.provider = ?
				 AND cv.model = ?
				 AND c.memory_id IN (${placeholders(validIds.length)})`
			)
			.all(embProvider.provider, embProvider.model, ...validIds) as Array<{
			id: string
			memory_id: string
			text: string
			hash: string
			embedding: RawEmbedding
			dims: number
		}>

		const scored = rows
			.map((row) => ({
				chunkId: row.id,
				memoryId: row.memory_id,
				text: row.text,
				hash: row.hash,
				score: cosineSimilarity(queryEmbedding, toFloat32Array(row.embedding))
			}))
			.sort((a, b) => b.score - a.score)

		return scored
			.filter((row) => Number.isFinite(row.score))
			.slice(0, candidateLimit)
			.map((row, rank) => ({
				chunkId: row.chunkId,
				memoryId: row.memoryId,
				text: row.text,
				hash: row.hash,
				rank,
				score: row.score,
				semanticScore: row.score
			}))
	}


	function chunksToResults(
		candidates: CandidateChunk[],
		query: string,
		limit: number,
		options?: SearchInput['options']
	): SearchResult[] {
		if (candidates.length === 0) return []

		const memoryIds = [...new Set(candidates.map((c) => c.memoryId))]
		if (memoryIds.length === 0) return []

		const memRows = db
			.prepare(
				`SELECT id, path, occurred_at, source FROM memories WHERE id IN (${placeholders(memoryIds.length)})`
			)
			.all(...memoryIds) as Array<{
			id: string
			path: string
			occurred_at: string | null
			source: string | null
		}>

		const memMap = new Map(memRows.map((m) => [m.id, m]))
		const seen = new Set<string>()
		const results: SearchResult[] = []

		for (const chunk of candidates) {
			if (seen.has(chunk.memoryId)) continue
			seen.add(chunk.memoryId)

			const mem = memMap.get(chunk.memoryId)
			if (!mem) continue

			let score = chunk.score
			if (options?.temporal_decay) {
				score = applyTemporalDecay(score, mem.occurred_at, options.decay_half_life_days ?? 30)
			}

			results.push({
				memory_id: chunk.memoryId,
				path: mem.path,
				score,
				semanticScore: chunk.semanticScore,
				ftsScore: chunk.ftsRank != null ? normalizeBm25(chunk.ftsRank) : undefined,
				snippet: generateSnippet(chunk.text, query),
				occurred_at: mem.occurred_at,
				source: mem.source ?? undefined
			})

			if (results.length >= limit) break
		}

		return results
	}

	function getCachedEmbeddings(chunkHashes: string[]): Map<string, Float32Array> {
		if (!embProvider || chunkHashes.length === 0) return new Map()

		const rows = db
			.prepare(
				`SELECT hash, embedding FROM embeddings_cache
				 WHERE provider = ? AND model = ? AND hash IN (${placeholders(chunkHashes.length)})`
			)
			.all(embProvider.provider, embProvider.model, ...chunkHashes) as Array<{
			hash: string
			embedding: RawEmbedding
		}>

		return new Map(rows.map((row) => [row.hash, toFloat32Array(row.embedding)]))
	}

	return {
		async capture(input: CaptureInput): Promise<string> {
			const normalized = normalizeText(input.text)
			const hash = await sha256hex(normalized)
			const now = new Date().toISOString()
			const scope = input.scope ?? 'personal'

			const existing = db
				.prepare('SELECT id FROM memories WHERE content_hash = ? AND active = 1 LIMIT 1')
				.get(hash) as { id: string } | undefined
			if (existing) return existing.id

			const path = input.path ?? `inbox/${now.slice(0, 19).replace(/[:.]/g, '')}`
			let oldPathMemoryId: string | null = null

			if (input.path) {
				const oldMemory = db
					.prepare('SELECT id FROM memories WHERE scope = ? AND path = ? AND active = 1 LIMIT 1')
					.get(scope, input.path) as { id: string } | undefined
				if (oldMemory) oldPathMemoryId = oldMemory.id
			}

			const chunks = chunkText(normalized)
			const chunkHashes = await Promise.all(chunks.map((c) => sha256hex(c.text)))

			const chunkEmbeddings: Array<Float32Array | null> = chunks.map(() => null)
			if (embProvider) {
				const cached = getCachedEmbeddings(chunkHashes)
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

						db.prepare(
							'INSERT OR REPLACE INTO embeddings_cache(hash, provider, model, dims, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
						).run(
							chunkHashes[chunkIndex],
							embProvider.provider,
							embProvider.model,
							vector.length,
							encodeEmbedding(Array.from(vector)),
							now
						)
					}
				}
			}

			const memoryId = genId('mem')

			const doInsert = db.transaction(() => {
				if (oldPathMemoryId) {
					db.prepare('UPDATE memories SET active = 0, updated_at = ? WHERE id = ?').run(
						now,
						oldPathMemoryId
					)
					db.prepare(
						'INSERT INTO events(id, memory_id, event_type, actor_type, actor_name, at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
					).run(
						genId('evt'),
						oldPathMemoryId,
						'archive',
						input.source ? 'agent' : 'system',
						input.source ?? null,
						now,
						JSON.stringify({ reason: 'replaced by path upsert' })
					)
				}

				db.prepare(
					'INSERT INTO memories(id, scope, title, content_hash, path, occurred_at, source, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
				).run(
					memoryId,
					scope,
					input.title ?? null,
					hash,
					path,
					input.occurred_at ?? null,
					input.source ?? null,
					now,
					now
				)

				if (input.tags?.length) {
					const tagInsert = db.prepare('INSERT INTO memory_tags(memory_id, tag) VALUES (?, ?)')
					for (const tag of input.tags) tagInsert.run(memoryId, tag)
				}

				const chunkInsert = db.prepare(
					'INSERT INTO chunks(id, memory_id, seq, start_line, end_line, text, token_count, hash, embedding_model, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
				)
				const vectorInsert = db.prepare(
					'INSERT INTO chunk_vectors(chunk_id, provider, model, dims, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
				)

				for (let i = 0; i < chunks.length; i++) {
					const chunk = chunks[i]
					const chunkId = genId('chk')
					chunkInsert.run(
						chunkId,
						memoryId,
						chunk.seq,
						chunk.startLine,
						chunk.endLine,
						chunk.text,
						chunk.tokenCount,
						chunkHashes[i],
						embModelKey,
						now
					)

					const embedding = chunkEmbeddings[i]
					if (embedding) {
						vectorInsert.run(
							chunkId,
							embProvider?.provider ?? 'none',
							embProvider?.model ?? 'none',
							embedding.length,
							Buffer.from(embedding.buffer),
							now
						)
					}
				}

				db.prepare(
					'INSERT INTO events(id, memory_id, event_type, actor_type, actor_name, at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
				).run(
					genId('evt'),
					memoryId,
					'capture',
					input.source ? 'agent' : 'human',
					input.source ?? null,
					now,
					null
				)
			})

			doInsert()
			return memoryId
		},

		async search(input: SearchInput): Promise<SearchResult[]> {
			const scope = input.scope ?? 'personal'
			const mode = input.mode ?? 'hybrid'
			const limit = input.limit ?? 10
			const minScore = input.min_score ?? (mode !== 'exact' ? 0.3 : 0)
			const candidateLimit = limit * 4

			const validIds = getValidMemoryIds(scope, input.filter)
			if (!validIds.length) return []

			let candidates: CandidateChunk[]
			if (mode === 'exact') {
				candidates = exactSearch(input.query, validIds, candidateLimit)
			} else if (mode === 'semantic') {
				if (!embProvider) return []
				const [queryEmbedding] = await embProvider.embed([input.query])
				candidates = semanticSearch(new Float32Array(queryEmbedding), validIds, candidateLimit)
			} else {
				const exact = exactSearch(input.query, validIds, candidateLimit)
				const queries =
					embProvider && queryExpander && !hasStrongExactSignal(exact)
						? [input.query, ...(await queryExpander.expand(input.query))]
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
			}

			return chunksToResults(candidates, input.query, limit, input.options).filter(
				(r) => r.score >= minScore
			)
		},

		async get(id: string): Promise<Memory> {
			const memory = db
				.prepare('SELECT * FROM memories WHERE id = ? AND active = 1 LIMIT 1')
				.get(id) as
				| {
						id: string
						scope: string
						title: string | null
						path: string
						occurred_at: string | null
						source: string | null
						created_at: string
						updated_at: string
				  }
				| undefined

			if (!memory) throw new Error(`Memory not found: ${id}`)

			const tags = db
				.prepare('SELECT tag FROM memory_tags WHERE memory_id = ?')
				.all(memory.id) as Array<{ tag: string }>

			const outgoing = db
				.prepare('SELECT to_id, rel_type, reason, created_at FROM memory_links WHERE from_id = ?')
				.all(memory.id) as Array<{
				to_id: string
				rel_type: string
				reason: string | null
				created_at: string
			}>

			const incoming = db
				.prepare('SELECT from_id, rel_type, reason, created_at FROM memory_links WHERE to_id = ?')
				.all(memory.id) as Array<{
				from_id: string
				rel_type: string
				reason: string | null
				created_at: string
			}>

			const chunkRows = db
				.prepare('SELECT text FROM chunks WHERE memory_id = ? ORDER BY seq')
				.all(memory.id) as Array<{ text: string }>

			db.prepare(
				'UPDATE memories SET last_retrieved_at = ?, retrieval_count = COALESCE(retrieval_count, 0) + 1 WHERE id = ?'
			).run(new Date().toISOString(), id)

			return {
				id: memory.id,
				scope: memory.scope,
				title: memory.title,
				raw_text: chunkRows.map((c) => c.text).join('\n'),
				path: memory.path,
				occurred_at: memory.occurred_at,
				source: memory.source,
				created_at: memory.created_at,
				updated_at: memory.updated_at,
				tags: tags.map((t) => t.tag),
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

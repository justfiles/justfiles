import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EmbeddingProvider } from '../embedding'
import type { QueryExpander } from '../llm'
import { applyTemporalDecay, cosineSimilarity, normalizeBm25, rrf, type CandidateChunk } from './scoring'
import type { CaptureInput, Memory, SearchInput, SearchResult, Store } from './types'
import {
	type RawEmbedding,
	chunkText,
	encodeEmbedding,
	generateSnippet,
	genId,
	hasStrongExactSignal,
	normalizeText,
	normalizeTags,
	placeholders,
	sha256hex,
	toFloat32Array
} from './utils'
import type { DbAdapter, SqlValue } from './db-adapter'

// ---- Migration ----
// Note: uses Node.js fs APIs — call only from Bun/Node environments, not CF Workers.

function parseSqlStatements(sql: string): string[] {
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

export async function migrate(adapter: DbAdapter): Promise<void> {
	await adapter.run(
		`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`
	)

	const [row] = await adapter.query<{ max_version: number }>('SELECT MAX(version) AS max_version FROM schema_migrations')
	const currentVersion = Number(row?.max_version ?? 0)

	const migrationDir = fileURLToPath(new URL('./migrations', import.meta.url).toString())
	const migrationFiles = readdirSync(migrationDir)
		.filter((name) => /^\d{4}_.*\.sql$/.test(name))
		.sort()

	for (const file of migrationFiles) {
		const version = parseInt(file.slice(0, 4), 10)
		if (version <= currentVersion) continue

		const sql = readFileSync(`${migrationDir}${sep}${file}`, 'utf8')
		for (const stmt of parseSqlStatements(sql)) {
			await adapter.run(stmt)
		}
		await adapter.run(
			`INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))`,
			[version]
		)
	}
}

// ---- Store Implementation ----

export function createStore(
	adapter: DbAdapter,
	embProvider?: EmbeddingProvider,
	queryExpander?: QueryExpander
): Store {
	const embModelKey = embProvider ? `${embProvider.provider}:${embProvider.model}` : 'none'

	async function getValidMemoryIds(scope: string, filter?: SearchInput['filter']): Promise<string[]> {
		const tags = normalizeTags(filter?.fields?.tags)
		const conditions = ['m.scope = ?', 'm.active = 1']
		const params: SqlValue[] = [scope]

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

		const rows = await adapter.query<{ id: unknown }>(sql, params)
		return rows.map((row) => String(row.id))
	}

	async function exactSearch(query: string, validIds: string[], candidateLimit: number): Promise<CandidateChunk[]> {
		if (validIds.length === 0) return []

		const rows = await adapter.query<{ id: unknown; memory_id: unknown; text: unknown; hash: unknown; fts_rank: unknown }>(
			`SELECT c.id, c.memory_id, c.text, c.hash, f.rank as fts_rank
			 FROM chunks_fts f
			 JOIN chunks c ON c.id = f.chunk_id
			 WHERE f.text MATCH ?
			 AND c.memory_id IN (${placeholders(validIds.length)})
			 ORDER BY f.rank
			 LIMIT ?`,
			[query, ...validIds, candidateLimit]
		)

		return rows.map((row, rank) => ({
			chunkId: String(row.id),
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

		const rows = await adapter.query<{ id: unknown; memory_id: unknown; text: unknown; hash: unknown; embedding: unknown }>(
			`SELECT c.id, c.memory_id, c.text, c.hash, cv.embedding
			 FROM chunks c
			 JOIN chunk_vectors cv ON cv.chunk_id = c.id
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
				score: cosineSimilarity(queryEmbedding, toFloat32Array(row.embedding as RawEmbedding | null))
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

		const rows = await adapter.query<{ id: unknown; path: unknown; occurred_at: unknown; source: unknown }>(
			`SELECT id, path, occurred_at, source FROM memories WHERE id IN (${placeholders(memoryIds.length)})`,
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

			const occurredAt = mem.occurred_at != null ? String(mem.occurred_at) : null
			let score = chunk.score
			if (options?.temporal_decay) {
				score = applyTemporalDecay(score, occurredAt, options.decay_half_life_days ?? 30)
			}

			results.push({
				memory_id: chunk.memoryId,
				path: String(mem.path),
				score,
				semanticScore: chunk.semanticScore,
				ftsScore: chunk.ftsRank != null ? normalizeBm25(chunk.ftsRank) : undefined,
				snippet: generateSnippet(chunk.text, query),
				occurred_at: occurredAt,
				source: mem.source != null ? String(mem.source) : undefined
			})

			if (results.length >= limit) break
		}

		return results
	}

	async function getCachedEmbeddings(chunkHashes: string[]): Promise<Map<string, Float32Array>> {
		if (!embProvider || chunkHashes.length === 0) return new Map()

		const rows = await adapter.query<{ hash: unknown; embedding: unknown }>(
			`SELECT hash, embedding FROM embeddings_cache
			 WHERE provider = ? AND model = ? AND hash IN (${placeholders(chunkHashes.length)})`,
			[embProvider.provider, embProvider.model, ...chunkHashes]
		)

		return new Map(rows.map((row) => [String(row.hash), toFloat32Array(row.embedding as RawEmbedding | null)]))
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

						await adapter.run(
							'INSERT OR REPLACE INTO embeddings_cache(hash, provider, model, dims, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
							[chunkHashes[chunkIndex], embProvider.provider, embProvider.model, vector.length, encodeEmbedding(Array.from(vector)), now]
						)
					}
				}
			}

			const memoryId = genId('mem')

			await adapter.transaction(async (tx) => {
				if (oldPathMemoryId) {
					await tx.run('UPDATE memories SET active = 0, updated_at = ? WHERE id = ?', [now, oldPathMemoryId])
					await tx.run(
						'INSERT INTO events(id, memory_id, event_type, actor_type, actor_name, at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
						[genId('evt'), oldPathMemoryId, 'archive', input.source ? 'agent' : 'system', input.source ?? null, now, JSON.stringify({ reason: 'replaced by path upsert' })]
					)
				}

				await tx.run(
					'INSERT INTO memories(id, scope, title, content_hash, path, occurred_at, source, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
					[memoryId, scope, input.title ?? null, hash, path, input.occurred_at ?? null, input.source ?? null, now, now]
				)

				if (input.tags?.length) {
					for (const tag of input.tags) {
						await tx.run('INSERT INTO memory_tags(memory_id, tag) VALUES (?, ?)', [memoryId, tag])
					}
				}

				for (let i = 0; i < chunks.length; i++) {
					const chunk = chunks[i]
					const chunkId = genId('chk')

					await tx.run(
						'INSERT INTO chunks(id, memory_id, seq, start_line, end_line, text, token_count, hash, embedding_model, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
						[chunkId, memoryId, chunk.seq, chunk.startLine, chunk.endLine, chunk.text, chunk.tokenCount, chunkHashes[i], embModelKey, now]
					)

					const embedding = chunkEmbeddings[i]
					if (embedding) {
						await tx.run(
							'INSERT INTO chunk_vectors(chunk_id, provider, model, dims, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
							[chunkId, embProvider?.provider ?? 'none', embProvider?.model ?? 'none', embedding.length, encodeEmbedding(Array.from(embedding)), now]
						)
					}
				}

				await tx.run(
					'INSERT INTO events(id, memory_id, event_type, actor_type, actor_name, at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
					[genId('evt'), memoryId, 'capture', input.source ? 'agent' : 'human', input.source ?? null, now, null]
				)
			})

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
				candidates = await semanticSearch(new Float32Array(queryEmbedding), validIds, candidateLimit)
			} else {
				const exact = await exactSearch(input.query, validIds, candidateLimit)
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

			return (await chunksToResults(candidates, input.query, limit, input.options)).filter(
				(r) => r.score >= minScore
			)
		},

		async get(id: string): Promise<Memory> {
			const [memory] = await adapter.query<{
				id: unknown; scope: unknown; title: unknown; path: unknown
				occurred_at: unknown; source: unknown; created_at: unknown; updated_at: unknown
			}>('SELECT * FROM memories WHERE id = ? AND active = 1 LIMIT 1', [id])

			if (!memory) throw new Error(`Memory not found: ${id}`)

			const [tags, outgoing, incoming, chunkRows] = await Promise.all([
				adapter.query<{ tag: unknown }>('SELECT tag FROM memory_tags WHERE memory_id = ?', [id]),
				adapter.query<{ to_id: unknown; rel_type: unknown; reason: unknown; created_at: unknown }>(
					'SELECT to_id, rel_type, reason, created_at FROM memory_links WHERE from_id = ?', [id]
				),
				adapter.query<{ from_id: unknown; rel_type: unknown; reason: unknown; created_at: unknown }>(
					'SELECT from_id, rel_type, reason, created_at FROM memory_links WHERE to_id = ?', [id]
				),
				adapter.query<{ text: unknown }>('SELECT text FROM chunks WHERE memory_id = ? ORDER BY seq', [id])
			])

			await adapter.run(
				'UPDATE memories SET last_retrieved_at = ?, retrieval_count = COALESCE(retrieval_count, 0) + 1 WHERE id = ?',
				[new Date().toISOString(), id]
			)

			return {
				id: String(memory.id),
				scope: String(memory.scope),
				title: memory.title != null ? String(memory.title) : null,
				raw_text: chunkRows.map((c) => String(c.text)).join('\n'),
				path: String(memory.path),
				occurred_at: memory.occurred_at != null ? String(memory.occurred_at) : null,
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
		}
	}
}

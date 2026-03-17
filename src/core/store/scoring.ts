export interface CandidateChunk {
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

export function normalizeBm25(ftsRank: number): number {
	const abs = Math.abs(ftsRank)
	return abs / (1 + abs)
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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

export function applyTemporalDecay(score: number, occurredAt: string | null, halfLifeDays: number): number {
	if (!occurredAt) return score
	const ageDays = (Date.now() - new Date(occurredAt).getTime()) / 86_400_000
	return score * Math.exp((-Math.LN2 / halfLifeDays) * ageDays)
}

// Position-aware blend: ranks 0–2 favour retrieval (75/25), ranks 10+ favour reranker (40/60).
export function blendWithReranker(
	retrievalScore: number,
	rerankerScore: number,
	rank: number
): number {
	const t = rank <= 2 ? 0 : rank >= 10 ? 1 : (rank - 2) / 8
	const retrievalWeight = 0.75 - 0.35 * t
	return Math.min(1, retrievalScore * retrievalWeight + rerankerScore * (1 - retrievalWeight))
}

export function rrf(lists: CandidateChunk[][], k = 60): CandidateChunk[] {
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

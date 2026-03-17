export type RerankCandidate = {
	id: string
	text: string
}

export type RerankResult = {
	id: string
	score: number // 0.0–1.0
}

export interface Reranker {
	rerank(query: string, candidates: RerankCandidate[]): Promise<RerankResult[]>
	readonly provider: string
	readonly model: string
}

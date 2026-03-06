import type { VectorMatch, VectorQueryInput, VectorRecord, VectorStore } from './index'

type VectorizeLike = {
	upsert(vectors: VectorRecord[]): Promise<{ mutationId?: string } | void>
	query(
		vector: number[] | Float32Array | Float64Array,
		options?: {
			topK?: number
			namespace?: string
			filter?: Record<string, unknown>
			returnValues?: boolean
			returnMetadata?: 'none' | 'indexed' | 'all' | boolean
		}
	): Promise<{ matches: VectorMatch[]; count: number }>
	deleteByIds(ids: string[]): Promise<{ mutationId?: string } | void>
}

export class VectorizeVectorStore implements VectorStore {
	constructor(
		private readonly index: VectorizeLike,
		private readonly defaultNamespace = 'default'
	) {}

	async upsert(vectors: VectorRecord[]): Promise<void> {
		if (!vectors.length) return
		await this.index.upsert(vectors)
	}

	private memoryFilter(memoryIds?: string[]): Record<string, unknown> | undefined {
		if (!memoryIds || memoryIds.length === 0) return undefined
		if (memoryIds.length === 1) return { memory_id: { $eq: memoryIds[0] } }
		return { memory_id: { $in: memoryIds } }
	}

	async query(input: VectorQueryInput): Promise<VectorMatch[]> {
		const result = await this.index.query(input.vector, {
			topK: input.topK,
			namespace: input.namespace ?? this.defaultNamespace,
			filter: this.memoryFilter(input.memoryIds),
			returnMetadata: false
		})

		return result.matches
	}

	async delete(ids: string[]): Promise<void> {
		if (!ids.length) return
		await this.index.deleteByIds(ids)
	}
}

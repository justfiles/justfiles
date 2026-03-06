import type { VectorMatch, VectorQueryInput, VectorRecord, VectorStore } from './index'

export class VectorizeVectorStore implements VectorStore {
	constructor(
		private readonly index: VectorizeIndex,
		private readonly defaultNamespace = 'default'
	) {}

	async upsert(vectors: VectorRecord[]): Promise<void> {
		if (!vectors.length) return
		await this.index.upsert(vectors)
	}

	private memoryFilter(memoryIds?: string[]): VectorizeVectorMetadataFilter | undefined {
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

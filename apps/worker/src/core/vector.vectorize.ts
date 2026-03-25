import type { VectorMatch, VectorQueryInput, VectorRecord, VectorStore } from './vector'

export class VectorizeVectorStore implements VectorStore {
	constructor(private readonly index: VectorizeIndex) {}

	async upsert(vectors: VectorRecord[]): Promise<void> {
		if (!vectors.length) return
		await this.index.upsert(vectors)
	}

	async query(input: VectorQueryInput): Promise<VectorMatch[]> {
		const result = await this.index.query(input.vector, {
			topK: input.topK,
			namespace: input.namespace,
			returnMetadata: 'none'
		})

		return result.matches
	}

	async delete(ids: string[]): Promise<void> {
		if (!ids.length) return
		await this.index.deleteByIds(ids)
	}
}

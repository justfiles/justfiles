export type VectorRecord = {
	id: string
	values: number[] | Float32Array
	namespace: string
}

export type VectorMatch = {
	id: string
	score: number
}

export type VectorQueryInput = {
	vector: number[] | Float32Array
	topK: number
	namespace: string
}

export interface VectorStore {
	upsert(vectors: VectorRecord[]): Promise<void>
	query(input: VectorQueryInput): Promise<VectorMatch[]>
	delete(ids: string[]): Promise<void>
}

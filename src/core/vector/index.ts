export type VectorMetadataValue =
	| string
	| number
	| boolean
	| string[]
	| Record<string, string | number | boolean | string[]>

export type VectorMetadata = Record<string, VectorMetadataValue>

export type VectorRecord = {
	id: string
	values: number[] | Float32Array | Float64Array
	metadata?: VectorMetadata
	namespace?: string
}

export type VectorMatch = {
	id: string
	score: number
	metadata?: VectorMetadata
}

export type VectorQueryInput = {
	vector: number[] | Float32Array | Float64Array
	topK: number
	memoryIds?: string[]
	namespace?: string
}

export interface VectorStore {
	upsert(vectors: VectorRecord[]): Promise<void>

	query(input: VectorQueryInput): Promise<VectorMatch[]>

	delete(ids: string[]): Promise<void>
}

export { VectorizeVectorStore } from './vectorize'

import { QueryClient } from '@tanstack/react-query'
import type { Memory } from '../core/store'
import type { UpdateInput } from '../core/store'
import type { ApiClient } from './useApiClient'

export type RemoteMemory = Memory
export type RemoteDraft = {
	id: string
	raw_text: string
	updated_at?: string
}

export interface RemoteMemoryService {
	pull(memoryId: string): Promise<RemoteMemory | null>
	getDraft(): Promise<RemoteDraft>
	push(input: UpdateInput): Promise<void>
}

function memoryQueryKey(memoryId: string) {
	return ['memory', memoryId] as const
}

function draftQueryKey() {
	return ['draft-memory'] as const
}

export function createTanstackRemoteMemoryService(
	queryClient: QueryClient,
	api: ApiClient
): RemoteMemoryService {
	return {
		async pull(memoryId) {
			const key = memoryQueryKey(memoryId)
			const cached = queryClient.getQueryData<RemoteMemory | null>(key)
			if (cached !== undefined) return cached

			return queryClient.fetchQuery({
				queryKey: key,
				queryFn: async (): Promise<RemoteMemory | null> => {
					const res = await api.v1.memory[':id'].$get({ param: { id: memoryId } })
					if (res.status === 404) return null
					if (!res.ok) throw new Error(`Failed to load memory: ${res.status}`)
					const data = await res.json()
					return {
						id: data.id,
						scope: data.scope,
						raw_text: data.raw_text,
						title: data.title,
						path: data.path,
						source: data.source,
						created_at: data.created_at,
						updated_at: data.updated_at,
						active: data.active,
						links: data.links,
						tags: data.tags
					}
				}
			})
		},

		async getDraft() {
			const key = draftQueryKey()
			const cached = queryClient.getQueryData<RemoteDraft>(key)
			if (cached !== undefined) return cached

			return queryClient.fetchQuery({
				queryKey: key,
				queryFn: async (): Promise<RemoteDraft> => {
					const res = await api.v1.draft.$get()
					if (!res.ok) throw new Error(`Failed to load draft: ${res.status}`)
					const data = await res.json()
					return {
						id: data.id,
						raw_text: data.raw_text
					}
				}
			})
		},

		async push(input) {
			const res = await api.v1.update.$post({ json: input })
			if (!res.ok) throw new Error(`Failed to update memory: ${res.status}`)

			if (input.id) {
				const key = memoryQueryKey(input.id)
				const existing = queryClient.getQueryData<RemoteMemory | null>(key)
				if (existing) {
					queryClient.setQueryData<RemoteMemory>(key, {
						...existing,
						raw_text: input.content ?? existing.raw_text,
						title: input.title ?? existing.title,
						path: input.path ?? existing.path,
						updated_at: input.updated_at ?? new Date().toISOString()
					})
				} else {
					await queryClient.invalidateQueries({ queryKey: key })
				}
			}
		}
	}
}

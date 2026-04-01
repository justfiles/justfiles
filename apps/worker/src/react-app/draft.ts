import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createTanstackRemoteMemoryService } from './remote'
import { useApiClient } from './useApiClient'
import { useMemory } from './useMemory'
import type { ProseMirrorJsonDocument } from './sync'

const DRAFT_ID_KEY = 'ghostore:draft-id'

type DraftHook = {
	readonly id: string | null
	readonly isLoading: boolean
	readonly content: ProseMirrorJsonDocument | null
	save(content: ProseMirrorJsonDocument): void
	submit(path: string): Promise<void>
}

function loadStoredDraftId(): string | null {
	try {
		return localStorage.getItem(DRAFT_ID_KEY)
	} catch {
		return null
	}
}

function saveStoredDraftId(id: string): void {
	try {
		localStorage.setItem(DRAFT_ID_KEY, id)
	} catch {}
}

export function useDraft(): DraftHook {
	const api = useApiClient()
	const queryClient = useQueryClient()
	const remote = createTanstackRemoteMemoryService(queryClient, api)
	const [id, setId] = useState<string | null>(() => loadStoredDraftId())
	const [isLoading, setIsLoading] = useState(true)
	const memory = useMemory(id)

	useEffect(() => {
		let cancelled = false

		async function load(): Promise<void> {
			setIsLoading(true)
			try {
				const data = await remote.getDraft()
				if (cancelled) return
				setId(data.id)
				saveStoredDraftId(data.id)
			} finally {
				if (!cancelled) setIsLoading(false)
			}
		}

		void load()

		return () => {
			cancelled = true
		}
	}, [api])

	async function submit(path: string): Promise<void> {
		if (!id) throw new Error('Draft is not ready')
		await memory.movePath(path)
		await queryClient.removeQueries({ queryKey: ['draft-memory'] })
		const data = await remote.getDraft()
		setId(data.id)
		saveStoredDraftId(data.id)
	}

	return {
		id,
		isLoading: isLoading || memory.isLoading,
		content: memory.content,
		save: memory.saveContent,
		submit
	}
}

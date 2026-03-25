import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createTanstackRemoteMemoryService } from './remote'
import { useSync } from './sync'
import { useApiClient } from './useApiClient'

const DRAFT_ID_KEY = 'ghostore:draft-id'

type DraftHook = {
	readonly id: string | null
	readonly isLoading: boolean
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
	const sync = useSync()
	const [id, setId] = useState<string | null>(() => loadStoredDraftId())
	const [isLoading, setIsLoading] = useState(true)

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
		await sync.push(id, { path }, true)
		await queryClient.removeQueries({ queryKey: ['draft-memory'] })
		const data = await remote.getDraft()
		setId(data.id)
		saveStoredDraftId(data.id)
	}

	return {
		id,
		isLoading,
		submit
	}
}

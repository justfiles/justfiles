import { useEffect, useState } from 'react'
import { useSync } from './sync'
import { useApiClient } from './useApiClient'

const DRAFT_ID_KEY = 'ghostore:draft-id'

/**
 * Owns the app-level concept of "the current draft".
 *
 * The draft is a normal memory with a real memory ID. This hook is responsible
 * for resolving which memory currently plays that role.
 */
export interface DraftService {
	getCurrentDraftId(): Promise<string>
	submitCurrentDraft(path: string): Promise<void>
}

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
	const sync = useSync()
	const [id, setId] = useState<string | null>(() => loadStoredDraftId())
	const [isLoading, setIsLoading] = useState(true)

	useEffect(() => {
		let cancelled = false

		async function load(): Promise<void> {
			setIsLoading(true)
			try {
				const res = await api.v1.draft.$get()
				if (!res.ok) throw new Error(`Failed to load draft: ${res.status}`)
				const data = (await res.json()) as { id: string }
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
		const res = await api.v1.draft.$get()
		if (!res.ok) throw new Error(`Failed to refresh draft: ${res.status}`)
		const data = (await res.json()) as { id: string }
		setId(data.id)
		saveStoredDraftId(data.id)
	}

	return {
		id,
		isLoading,
		submit
	}
}

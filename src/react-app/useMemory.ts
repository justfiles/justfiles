import { useCallback, useEffect, useState } from 'react'
import { type ProseMirrorJsonDocument, type SyncDocumentData, useSync } from './sync'

export function useMemory(id: string | null) {
	const sync = useSync()
	const [isLoading, setIsLoading] = useState(false)
	const [memory, setMemory] = useState<SyncDocumentData<ProseMirrorJsonDocument> | null>(null)

	useEffect(() => {
		if (!id) {
			setMemory(null)
			setIsLoading(false)
			return
		}
		const currentId = id

		let cancelled = false

		async function load(): Promise<void> {
			setIsLoading(true)
			try {
				const doc = await sync.load(currentId)
				if (cancelled) return
				setMemory(doc?.data ?? null)
			} finally {
				if (!cancelled) setIsLoading(false)
			}
		}

		void load()

		return () => {
			cancelled = true
		}
	}, [id])

	const save = useCallback((v: ProseMirrorJsonDocument) => {
		if (!id) return Promise.resolve({ localUpdatedAt: Date.now(), queuedRemoteSync: false })
		return sync.push(id, { content: v })
	}, [id])

	return {
		memory,
		content: memory?.content ?? null,
		save,
		isLoading
	}
}

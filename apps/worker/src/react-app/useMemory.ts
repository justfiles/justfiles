import { useCallback, useEffect, useRef, useState } from 'react'
import type { LinkInfo } from '@ghostore/core'
import { type ProseMirrorJsonDocument, useSync } from './sync'

export interface MemoryData {
	content: ProseMirrorJsonDocument
	id?: string
	title?: string | null
	path?: string | null
	source?: string | null
	created_at?: string
	updated_at?: string
	active?: number
	links?: LinkInfo[]
	tags?: string[]
}

export function useMemory(id: string | null) {
	const sync = useSync()
	const [isLoading, setIsLoading] = useState(false)
	const [memory, setMemory] = useState<MemoryData | null>(null)
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
	}, [id, sync])

	useEffect(() => {
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current)
		}
	}, [])

	const saveContent = useCallback((content: ProseMirrorJsonDocument) => {
		if (!id) return
		setMemory((current) => (current ? { ...current, content } : current))
		if (debounceRef.current) clearTimeout(debounceRef.current)
		debounceRef.current = setTimeout(() => {
			debounceRef.current = null
			void sync.push(id, { content })
		}, 500)
	}, [id, sync])

	const saveTitle = useCallback(async (title: string | null) => {
		if (!id) return
		await sync.push(id, { title }, true)
		const now = new Date().toISOString()
		setMemory((current) => (current ? { ...current, title, updated_at: now } : current))
	}, [id, sync])

	const movePath = useCallback(async (path: string) => {
		if (!id) return
		await sync.push(id, { path }, true)
		const now = new Date().toISOString()
		setMemory((current) => (current ? { ...current, path, updated_at: now } : current))
	}, [id, sync])

	return {
		memory,
		content: memory?.content ?? null,
		saveContent,
		saveTitle,
		movePath,
		isLoading
	}
}

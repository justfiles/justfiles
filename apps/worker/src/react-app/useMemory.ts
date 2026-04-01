import { useCallback, useEffect, useRef, useState } from 'react'
import type { LinkInfo } from '@ghostore/core'
import { GHOSTORE_XATTR, decodeXattr, encodeXattr } from 'ghost-fs/xattr'
import { docToMarkdown, markdownToDoc, schema as remarkSchema } from '../prosemirror-remark'
import { openEditCache, type EditCache } from './editCache'
import { type ProseMirrorJsonDocument } from './sync'
import { useApiClient } from './useApiClient'
import { useVolume } from './useVolume'

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

interface MemoryResponse {
	id: string
	raw_text: string
	path: string
	title: string | null
	source: string | null
	tags: string[]
	links: LinkInfo[]
	created_at: string
	updated_at: string
	active: number
}

let editCachePromise: Promise<EditCache> | null = null

function getEditCache(): Promise<EditCache> {
	if (!editCachePromise) {
		editCachePromise = openEditCache()
	}
	return editCachePromise
}

function sameContent(
	left: ProseMirrorJsonDocument | null,
	right: ProseMirrorJsonDocument,
): boolean {
	return left !== null && JSON.stringify(left) === JSON.stringify(right)
}

function markdownToJson(markdown: string): ProseMirrorJsonDocument {
	return markdownToDoc(markdown, remarkSchema).toJSON() as ProseMirrorJsonDocument
}

function jsonToMarkdown(content: ProseMirrorJsonDocument): string {
	return docToMarkdown(remarkSchema.nodeFromJSON(content))
}

function toVolumePath(path: string): string {
	return path.startsWith('/') ? path : `/${path}`
}

function nsToIso(ns: bigint): string {
	return new Date(Number(ns / 1_000_000n)).toISOString()
}

async function decodeOptionalXattr<T>(
	read: Promise<Uint8Array | null>,
): Promise<T | null> {
	const value = await read
	return value ? decodeXattr<T>(value) : null
}

export function useMemory(id: string | null) {
	const api = useApiClient()
	const { volume, index } = useVolume()
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
				const cache = await getEditCache()
				const cachedContent = await cache.get(currentId)
				let path = index.getPath(currentId)
				let archivedFallback: MemoryResponse | null = null

				if (!path) {
					const res = await api.v1.memory[':id'].$get({ param: { id: currentId } })
					if (res.ok) {
						const data = await res.json() as MemoryResponse
						if (data.active !== 0) {
							path = data.path
							index.upsert({
								id: data.id,
								title: data.title,
								path: data.path,
								updated_at: data.updated_at,
								tags: data.tags,
								active: data.active,
							})
						} else {
							archivedFallback = data
						}
					}
				}

				let nextMemory: MemoryData | null = null
				if (path) {
					const volumePath = toVolumePath(path)
					try {
						const [
							markdown,
							stat,
							title,
							tags,
							links,
							source,
						] = await Promise.all([
							volume.readFile(volumePath),
							volume.stat(volumePath),
							decodeOptionalXattr<string>(volume.getXattr(volumePath, GHOSTORE_XATTR.title)),
							decodeOptionalXattr<string[]>(volume.getXattr(volumePath, GHOSTORE_XATTR.tags)),
							decodeOptionalXattr<LinkInfo[]>(volume.getXattr(volumePath, GHOSTORE_XATTR.links)),
							decodeOptionalXattr<string>(volume.getXattr(volumePath, GHOSTORE_XATTR.source)),
						])

						nextMemory = {
							id: currentId,
							content: markdownToJson(new TextDecoder().decode(markdown)),
							title,
							path,
							source,
							created_at: nsToIso(stat.ctimeNs),
							updated_at: nsToIso(stat.mtimeNs),
							active: 1,
							links: links ?? [],
							tags: tags ?? [],
						}
					} catch {
						path = null
					}
				}

				if (!nextMemory && archivedFallback) {
					nextMemory = {
						id: archivedFallback.id,
						content: markdownToJson(archivedFallback.raw_text),
						title: archivedFallback.title,
						path: archivedFallback.path,
						source: archivedFallback.source,
						created_at: archivedFallback.created_at,
						updated_at: archivedFallback.updated_at,
						active: archivedFallback.active,
						links: archivedFallback.links,
						tags: archivedFallback.tags,
					}
				}

				if (cancelled) return

				setMemory(cachedContent && nextMemory ? { ...nextMemory, content: cachedContent } : nextMemory)

				if (cachedContent && nextMemory?.path) {
					void (async () => {
						try {
							await volume.writeFile(
								toVolumePath(nextMemory.path!),
								new TextEncoder().encode(jsonToMarkdown(cachedContent))
							)
							const latest = await cache.get(currentId)
							if (sameContent(latest, cachedContent)) {
								await cache.delete(currentId)
							}
						} catch {}
					})()
				}
			} finally {
				if (!cancelled) setIsLoading(false)
			}
		}

		void load()

		return () => {
			cancelled = true
			if (debounceRef.current) clearTimeout(debounceRef.current)
			debounceRef.current = null
		}
	}, [api, id, index, volume])

	useEffect(() => {
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current)
		}
	}, [])

	const saveContent = useCallback((content: ProseMirrorJsonDocument) => {
		if (!id || !memory?.path || memory.active === 0) return
		setMemory((current) => (current ? { ...current, content } : current))
		void getEditCache()
			.then((cache) => cache.put(id, content))
			.catch(() => {})
		const volumePath = toVolumePath(memory.path)
		if (debounceRef.current) clearTimeout(debounceRef.current)
		debounceRef.current = setTimeout(() => {
			debounceRef.current = null
			void (async () => {
				let cache: EditCache | null = null
				try {
					cache = await getEditCache()
				} catch {}

				try {
					await volume.writeFile(
						volumePath,
						new TextEncoder().encode(jsonToMarkdown(content))
					)
					if (cache) {
						const latest = await cache.get(id)
						if (sameContent(latest, content)) {
							await cache.delete(id)
						}
					}
				} catch {}
			})()
		}, 500)
	}, [id, memory?.active, memory?.path, volume])

	const saveTitle = useCallback(async (title: string | null) => {
		if (!id || !memory?.path || memory.active === 0) return
		const volumePath = toVolumePath(memory.path)
		if (title === null) {
			await volume.removeXattr(volumePath, GHOSTORE_XATTR.title)
		} else {
			await volume.setXattr(volumePath, GHOSTORE_XATTR.title, encodeXattr(title))
		}
		const now = new Date().toISOString()
		setMemory((current) => (current ? { ...current, title, updated_at: now } : current))
	}, [id, memory?.active, memory?.path, volume])

	const movePath = useCallback(async (path: string) => {
		if (!id || !memory?.path || memory.active === 0) return
		const oldPath = memory.path
		await volume.rename(toVolumePath(oldPath), toVolumePath(path))
		const now = new Date().toISOString()
		const existing = index.get(id)
		if (existing) {
			index.upsert({ ...existing, path, updated_at: now })
		}
		setMemory((current) => (current ? { ...current, path, updated_at: now } : current))
	}, [id, index, memory?.active, memory?.path, volume])

	return {
		memory,
		content: memory?.content ?? null,
		saveContent,
		saveTitle,
		movePath,
		isLoading
	}
}

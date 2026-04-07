import { useCallback, useEffect, useRef, useState } from 'react'
import type { LinkInfo } from '@ghostore/core'
import { GHOSTORE_XATTR, encodeXattr } from 'just-files/xattr'
import { docToMarkdown, markdownToDoc, schema as remarkSchema } from '../prosemirror-remark'
import { openEditCache, type EditCache } from './editCache'
import { type ProseMirrorJsonDocument } from './sync'
import { useVolume } from './useVolume'
import { normalizeVolumePath, parentVolumePath } from './assets'

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

export function useMemory(id: string | null) {
	const { volume, resolveMemory, writeAssetFile, resolveAssetUrl, readAssetBlob } = useVolume()
	const [isLoading, setIsLoading] = useState(false)
	const [memory, setMemory] = useState<MemoryData | null>(null)
	const [reloadVersion, setReloadVersion] = useState(0)
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
				const resolved = await resolveMemory(currentId)
				const record = resolved.record

				const nextMemory: MemoryData | null = record
					? {
						id: record.id,
						content: markdownToJson(record.raw_text),
						title: record.title,
						path: record.path,
						source: record.source,
						created_at: record.created_at,
						updated_at: record.updated_at,
						active: record.active,
						links: record.links,
						tags: record.tags,
					}
					: null

				if (cancelled) return

				setMemory(cachedContent && nextMemory ? { ...nextMemory, content: cachedContent } : nextMemory)

				if (cachedContent && nextMemory?.path && nextMemory.active !== 0) {
					const nextPath = nextMemory.path
					void (async () => {
						try {
							await volume.writeFile(
								normalizeVolumePath(nextPath),
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
	}, [id, reloadVersion, resolveMemory, volume])

	useEffect(() => {
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current)
		}
	}, [])

	const saveContent = useCallback((content: ProseMirrorJsonDocument) => {
		if (!id || !memory?.path || memory.active === 0) return
		const notePath = memory.path
		setMemory((current) => (current ? { ...current, content } : current))
		void getEditCache()
			.then((cache) => cache.put(id, content))
			.catch(() => {})
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
						normalizeVolumePath(notePath),
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
		const volumePath = normalizeVolumePath(memory.path)
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
		const normalizedOldPath = normalizeVolumePath(oldPath)
		const normalizedNewPath = normalizeVolumePath(path)
		await volume.mkdir(parentVolumePath(normalizedNewPath), { recursive: true })
		await volume.rename(normalizedOldPath, normalizedNewPath)
		const now = new Date().toISOString()
		setMemory((current) => (current ? { ...current, path, updated_at: now } : current))
	}, [id, memory?.active, memory?.path, volume])

	const uploadAsset = useCallback(async (file: File) => {
		if (!id || !memory?.path || memory.active === 0) {
			throw new Error('Cannot upload asset for an archived or missing note')
		}
		return writeAssetFile(file)
	}, [id, memory?.active, memory?.path, writeAssetFile])

	const getAssetUrl = useCallback(async (src: string) => {
		if (!memory?.path) return src
		return resolveAssetUrl(memory.path, src)
	}, [memory?.path, resolveAssetUrl])

	const loadAssetBlob = useCallback(async (src: string) => {
		if (!memory?.path) return null
		return readAssetBlob(memory.path, src)
	}, [memory?.path, readAssetBlob])

	const reload = useCallback(() => {
		setReloadVersion((version) => version + 1)
	}, [])

	return {
		memory,
		content: memory?.content ?? null,
		saveContent,
		saveTitle,
		movePath,
		uploadAsset,
		getAssetUrl,
		loadAssetBlob,
		reload,
		isLoading
	}
}

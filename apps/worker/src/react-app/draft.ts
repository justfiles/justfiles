import { useCallback, useEffect, useRef, useState } from 'react'
import { docToMarkdown, markdownToDoc, schema as remarkSchema } from '../prosemirror-remark'
import type { ProseMirrorJsonDocument } from './sync'
import { useVolume } from './useVolume'

const DRAFT_PATH = '/*draft*'

type DraftHook = {
	readonly id: string | null
	readonly isLoading: boolean
	readonly content: ProseMirrorJsonDocument | null
	save(content: ProseMirrorJsonDocument): void
	submit(path: string): Promise<void>
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

function parentVolumePath(path: string): string {
	const volumePath = toVolumePath(path)
	const lastSlash = volumePath.lastIndexOf('/')
	return lastSlash <= 0 ? '/' : volumePath.slice(0, lastSlash)
}

function entryPath(path: string): string {
	return path.startsWith('/') ? path.slice(1) : path
}

const EMPTY_DRAFT_DOC = markdownToJson('')

export function useDraft(): DraftHook {
	const { volume, upsertEntry } = useVolume()
	const [id, setId] = useState<string | null>(null)
	const [content, setContent] = useState<ProseMirrorJsonDocument | null>(null)
	const [isLoading, setIsLoading] = useState(true)
	const contentRef = useRef<ProseMirrorJsonDocument | null>(null)
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	contentRef.current = content

	const loadDraft = useCallback(async () => {
		if (!(await volume.exists(DRAFT_PATH))) {
			await volume.writeFile(DRAFT_PATH, new Uint8Array())
		}

		const stat = await volume.stat(DRAFT_PATH)
		const raw = await volume.readFile(DRAFT_PATH)
		const nextContent = markdownToJson(new TextDecoder().decode(raw))

		setId(stat.ino)
		setContent(nextContent)
		contentRef.current = nextContent
	}, [volume])

	const flushDraft = useCallback(async (nextContent?: ProseMirrorJsonDocument | null) => {
		if (debounceRef.current) {
			clearTimeout(debounceRef.current)
			debounceRef.current = null
		}

		const current = nextContent ?? contentRef.current
		if (!current) return

		await volume.writeFile(
			DRAFT_PATH,
			new TextEncoder().encode(jsonToMarkdown(current)),
		)
	}, [volume])

	useEffect(() => {
		let cancelled = false

		void (async () => {
			setIsLoading(true)
			try {
				await loadDraft()
			} finally {
				if (!cancelled) setIsLoading(false)
			}
		})()

		return () => {
			cancelled = true
			if (debounceRef.current) clearTimeout(debounceRef.current)
			debounceRef.current = null
		}
	}, [loadDraft])

	const save = useCallback((nextContent: ProseMirrorJsonDocument) => {
		setContent(nextContent)
		contentRef.current = nextContent

		if (debounceRef.current) clearTimeout(debounceRef.current)
		debounceRef.current = setTimeout(() => {
			debounceRef.current = null
			void flushDraft(nextContent)
		}, 500)
	}, [flushDraft])

	const submit = useCallback(async (path: string) => {
		await flushDraft()

		const targetPath = toVolumePath(path)
		await volume.mkdir(parentVolumePath(targetPath), { recursive: true })
		await volume.rename(DRAFT_PATH, targetPath)

		const submittedStat = await volume.stat(targetPath)
		upsertEntry({
			id: submittedStat.ino,
			title: null,
			path: entryPath(targetPath),
			updated_at: new Date().toISOString(),
			tags: [],
			active: 1,
		})

		await volume.writeFile(DRAFT_PATH, new Uint8Array())
		const nextDraftStat = await volume.stat(DRAFT_PATH)
		setId(nextDraftStat.ino)
		setContent(EMPTY_DRAFT_DOC)
		contentRef.current = EMPTY_DRAFT_DOC
	}, [flushDraft, upsertEntry, volume])

	return {
		id,
		isLoading,
		content,
		save,
		submit,
	}
}

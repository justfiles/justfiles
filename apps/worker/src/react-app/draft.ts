import type { Volume } from 'just-files'
import { useCallback, useEffect, useRef, useState } from 'react'
import { docToMarkdown, markdownToDoc, schema as remarkSchema } from '../prosemirror-remark'
import { normalizeVolumePath, parentVolumePath } from './assets'
import type { ProseMirrorJsonDocument } from './editCache'
import { useVolume } from './useVolume'

const DRAFT_PATH = '/*draft*'
let ensureDraftPromise: Promise<void> | null = null

type DraftHook = {
	readonly id: string | null
	readonly isLoading: boolean
	readonly content: ProseMirrorJsonDocument | null
	save(content: ProseMirrorJsonDocument): void
	submit(path: string): Promise<void>
	uploadAsset(file: File): Promise<string>
	getAssetUrl(src: string): Promise<string | null>
	loadAssetBlob(src: string): Promise<Blob | null>
}

function markdownToJson(markdown: string): ProseMirrorJsonDocument {
	return markdownToDoc(markdown, remarkSchema).toJSON() as ProseMirrorJsonDocument
}

function jsonToMarkdown(content: ProseMirrorJsonDocument): string {
	return docToMarkdown(remarkSchema.nodeFromJSON(content))
}

function entryPath(path: string): string {
	return path.startsWith('/') ? path.slice(1) : path
}

const EMPTY_DRAFT_DOC = markdownToJson('')

function isFsError(error: unknown, code: string): boolean {
	return error instanceof Error && error.message.startsWith(`${code}:`)
}

function waitTick(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0)
	})
}

async function ensureDraftFile(volume: Volume): Promise<void> {
	if (ensureDraftPromise === null) {
		ensureDraftPromise = (async () => {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				try {
					await volume.stat(DRAFT_PATH)
					return
				} catch (error) {
					if (!isFsError(error, 'ENOENT')) throw error
				}

				try {
					await volume.writeFile(DRAFT_PATH, new Uint8Array())
					return
				} catch (error) {
					if (!isFsError(error, 'EEXIST')) throw error
				}

				await waitTick()
			}

			await volume.stat(DRAFT_PATH)
		})()
	}

	try {
		await ensureDraftPromise
	} finally {
		ensureDraftPromise = null
	}
}

export function useDraft(): DraftHook {
	const { volume, upsertEntry, writeAssetFile, resolveAssetUrl, readAssetBlob } = useVolume()
	const [id, setId] = useState<string | null>(null)
	const [content, setContent] = useState<ProseMirrorJsonDocument | null>(null)
	const [isLoading, setIsLoading] = useState(true)
	const contentRef = useRef<ProseMirrorJsonDocument | null>(null)
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	contentRef.current = content

	const loadDraft = useCallback(async () => {
		await ensureDraftFile(volume)
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
		if (!id) throw new Error('Draft inode is not ready')
		await flushDraft()

		const targetPath = normalizeVolumePath(path)
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
	}, [flushDraft, id, upsertEntry, volume])

	const uploadAsset = useCallback(async (file: File) => {
		if (!id) throw new Error('Draft inode is not ready')
		return writeAssetFile(file)
	}, [id, writeAssetFile])

	const getAssetUrl = useCallback(async (src: string) => {
		return resolveAssetUrl(DRAFT_PATH, src)
	}, [resolveAssetUrl])

	const loadAssetBlob = useCallback(async (src: string) => {
		return readAssetBlob(DRAFT_PATH, src)
	}, [readAssetBlob])

	return {
		id,
		isLoading,
		content,
		save,
		submit,
		uploadAsset,
		getAssetUrl,
		loadAssetBlob,
	}
}

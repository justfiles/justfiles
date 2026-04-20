import type { Volume } from '@justfiles/fs'
import { useCallback, useEffect, useRef, useState } from 'react'
import { docToMarkdown, markdownToDoc, schema as remarkSchema } from '../prosemirror-remark'
import { basename, normalizeVolumePath, parentVolumePath } from './assets'
import type { ProseMirrorJsonDocument } from './editCache'
import { useVolume } from './useVolume'

const LEGACY_DRAFT_PATH = '/*draft*'
const SCRATCH_PATH = '/*scratch*'
let ensureScratchPromise: Promise<void> | null = null

type ScratchHook = {
	readonly id: string | null
	readonly isLoading: boolean
	readonly content: ProseMirrorJsonDocument | null
	save(content: ProseMirrorJsonDocument): void
	submit(path: string): Promise<{ id: string; path: string }>
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

function splitFilename(filename: string): { stem: string; extension: string } {
	const idx = filename.lastIndexOf('.')
	if (idx <= 0) return { stem: filename, extension: '' }
	return {
		stem: filename.slice(0, idx),
		extension: filename.slice(idx)
	}
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

async function ensureScratchFile(volume: Volume): Promise<void> {
	if (ensureScratchPromise === null) {
		ensureScratchPromise = (async () => {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				try {
					await volume.stat(SCRATCH_PATH)
					return
				} catch (error) {
					if (!isFsError(error, 'ENOENT')) throw error
				}

				try {
					if (await volume.exists(LEGACY_DRAFT_PATH)) {
						await volume.rename(LEGACY_DRAFT_PATH, SCRATCH_PATH)
						return
					}
					await volume.writeFile(SCRATCH_PATH, new Uint8Array())
					return
				} catch (error) {
					if (!isFsError(error, 'EEXIST')) throw error
				}

				await waitTick()
			}

			await volume.stat(SCRATCH_PATH)
		})()
	}

	try {
		await ensureScratchPromise
	} finally {
		ensureScratchPromise = null
	}
}

export function useScratch(): ScratchHook {
	const { volume, upsertEntry, writeAssetFile, resolveAssetUrl, readAssetBlob } = useVolume()
	const [id, setId] = useState<string | null>(null)
	const [content, setContent] = useState<ProseMirrorJsonDocument | null>(null)
	const [isLoading, setIsLoading] = useState(true)
	const contentRef = useRef<ProseMirrorJsonDocument | null>(null)
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	contentRef.current = content

	const loadScratch = useCallback(async () => {
		await ensureScratchFile(volume)
		const stat = await volume.stat(SCRATCH_PATH)
		const raw = await volume.readFile(SCRATCH_PATH)
		const nextContent = markdownToJson(new TextDecoder().decode(raw))

		setId(stat.ino)
		setContent(nextContent)
		contentRef.current = nextContent
	}, [volume])

	const flushScratch = useCallback(
		async (nextContent?: ProseMirrorJsonDocument | null) => {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current)
				debounceRef.current = null
			}

			const current = nextContent ?? contentRef.current
			if (!current) return

			await volume.writeFile(SCRATCH_PATH, new TextEncoder().encode(jsonToMarkdown(current)))
		},
		[volume]
	)

	useEffect(() => {
		let cancelled = false

		void (async () => {
			setIsLoading(true)
			try {
				await loadScratch()
			} finally {
				if (!cancelled) setIsLoading(false)
			}
		})()

		return () => {
			cancelled = true
			if (debounceRef.current) clearTimeout(debounceRef.current)
			debounceRef.current = null
		}
	}, [loadScratch])

	const save = useCallback(
		(nextContent: ProseMirrorJsonDocument) => {
			setContent(nextContent)
			contentRef.current = nextContent

			if (debounceRef.current) clearTimeout(debounceRef.current)
			debounceRef.current = setTimeout(() => {
				debounceRef.current = null
				void flushScratch(nextContent)
			}, 500)
		},
		[flushScratch]
	)

	const submit = useCallback(
		async (path: string) => {
			if (!id) throw new Error('Scratch inode is not ready')
			await flushScratch()

			const targetPath = normalizeVolumePath(path)
			const targetDir = parentVolumePath(targetPath)
			const { stem, extension } = splitFilename(basename(targetPath))
			let resolvedPath = targetPath
			let attempt = 1

			while (await volume.exists(resolvedPath)) {
				attempt += 1
				resolvedPath = normalizeVolumePath(`${targetDir}/${stem} ${attempt}${extension}`)
			}

			await volume.mkdir(parentVolumePath(resolvedPath), { recursive: true })
			await volume.rename(SCRATCH_PATH, resolvedPath)

			const submittedStat = await volume.stat(resolvedPath)
			const submittedPath = entryPath(resolvedPath)
			upsertEntry({
				id: submittedStat.ino,
				title: null,
				path: submittedPath,
				updated_at: new Date().toISOString(),
				tags: [],
				active: 1
			})

			await volume.writeFile(SCRATCH_PATH, new Uint8Array())
			const nextScratchStat = await volume.stat(SCRATCH_PATH)
			setId(nextScratchStat.ino)
			setContent(EMPTY_DRAFT_DOC)
			contentRef.current = EMPTY_DRAFT_DOC
			return {
				id: submittedStat.ino,
				path: submittedPath
			}
		},
		[flushScratch, id, upsertEntry, volume]
	)

	const uploadAsset = useCallback(
		async (file: File) => {
			if (!id) throw new Error('Scratch inode is not ready')
			return writeAssetFile(file)
		},
		[id, writeAssetFile]
	)

	const getAssetUrl = useCallback(
		async (src: string) => {
			return resolveAssetUrl(SCRATCH_PATH, src)
		},
		[resolveAssetUrl]
	)

	const loadAssetBlob = useCallback(
		async (src: string) => {
			return readAssetBlob(SCRATCH_PATH, src)
		},
		[readAssetBlob]
	)

	return {
		id,
		isLoading,
		content,
		save,
		submit,
		uploadAsset,
		getAssetUrl,
		loadAssetBlob
	}
}

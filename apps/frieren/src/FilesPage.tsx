import { FileTreeView, type FileTreeItem } from '@justfiles/ui'
import { FileType } from '@justfiles/fs/types'
import { useEffect, useMemo, useState } from 'react'
import type { Volume } from './fs'
import { createFsVolume } from './fs'
import { navigate } from './clientRouter'

type FsFile = FileTreeItem

const decoder = new TextDecoder()

function basename(path: string): string {
	const parts = path.split('/').filter(Boolean)
	return parts[parts.length - 1] ?? ''
}

function extname(path: string): string {
	const name = basename(path)
	const index = name.lastIndexOf('.')
	return index > 0 ? name.slice(index) : ''
}

function stem(path: string): string {
	const name = basename(path)
	const extension = extname(path)
	return extension ? name.slice(0, -extension.length) : name
}

function joinPath(folderPath: string, name: string): string {
	return folderPath === '/' ? `/${name}` : `${folderPath}/${name}`
}

async function resolveMoveDestination(
	volume: Volume,
	itemPath: string,
	destinationFolderPath: string
): Promise<string> {
	const extension = extname(itemPath)
	const base = stem(itemPath)
	let candidate = joinPath(destinationFolderPath, `${base}${extension}`)
	let suffix = 2

	while (candidate !== itemPath && (await volume.exists(candidate))) {
		candidate = joinPath(destinationFolderPath, `${base}-${suffix}${extension}`)
		suffix += 1
	}

	return candidate
}

async function listFiles(volume: Volume): Promise<FsFile[]> {
	const files: FsFile[] = []

	await volume.scan('/', async (path, stat) => {
		if (stat.type !== FileType.Regular) return
		files.push({
			id: path,
			path
		})
	})

	return files.sort((left, right) => left.path.localeCompare(right.path))
}

export function FilesPage({ search }: { search: string }) {
	const selectedPath = useMemo(() => new URLSearchParams(search).get('path'), [search])

	const [volume, setVolume] = useState<Volume | null>(null)
	const [files, setFiles] = useState<FsFile[]>([])
	const [content, setContent] = useState('')
	const [loadingFiles, setLoadingFiles] = useState(true)
	const [loadingContent, setLoadingContent] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [organizeMode, setOrganizeMode] = useState(false)
	const [reloadToken, setReloadToken] = useState(0)
	const [movingItemId, setMovingItemId] = useState<string | null>(null)
	const showingDetail = Boolean(selectedPath)

	useEffect(() => {
		let cancelled = false

		void (async () => {
			setLoadingFiles(true)
			setError(null)
			try {
				const nextVolume = await createFsVolume()
				const nextFiles = await listFiles(nextVolume)
				if (cancelled) return
				setVolume(nextVolume)
				setFiles(nextFiles)
			} catch (cause) {
				if (cancelled) return
				setError(cause instanceof Error ? cause.message : String(cause))
			} finally {
				if (!cancelled) setLoadingFiles(false)
			}
		})()

		return () => {
			cancelled = true
		}
	}, [reloadToken])

	useEffect(() => {
		let cancelled = false

		if (!volume || !selectedPath) {
			setError(null)
			setLoadingContent(false)
			setContent('')
			return () => {
				cancelled = true
			}
		}

		void (async () => {
			setLoadingContent(true)
			setError(null)
			try {
				const bytes = await volume.readFile(selectedPath)
				if (cancelled) return
				setContent(decoder.decode(bytes))
			} catch (cause) {
				if (cancelled) return
				setError(cause instanceof Error ? cause.message : String(cause))
				setContent('')
			} finally {
				if (!cancelled) setLoadingContent(false)
			}
		})()

		return () => {
			cancelled = true
		}
	}, [selectedPath, volume])

	const selectFile = (item: FileTreeItem) => {
		navigate(`/files?path=${encodeURIComponent(item.path)}`)
	}

	const moveFile = async ({
		item,
		destinationFolderPath
	}: {
		item: FileTreeItem
		destinationFolderPath: string
	}) => {
		if (!volume) return

		setMovingItemId(item.id)
		setError(null)

		try {
			const nextPath = await resolveMoveDestination(volume, item.path, destinationFolderPath)
			if (nextPath !== item.path) {
				await volume.rename(item.path, nextPath)
			}

			const nextFiles = await listFiles(volume)
			setFiles(nextFiles)

			if (selectedPath === item.path) {
				navigate(`/files?path=${encodeURIComponent(nextPath)}`, { replace: true })
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			setMovingItemId(null)
		}
	}

	return (
		<div className="flex h-screen min-h-0 flex-col">
			<header className="navbar min-h-12 border-b border-base-300 px-4">
				<div className="flex flex-1 items-center gap-3">
					<button
						type="button"
						className="btn btn-ghost btn-xs text-base-content/60"
						onClick={() => navigate('/')}
						>
							Chat
						</button>
						<span className="text-lg font-semibold">Files</span>
					</div>
					<div className="flex flex-none items-center gap-2">
						<button
							type="button"
							className={`btn btn-ghost btn-xs ${organizeMode ? 'text-primary' : 'text-base-content/60'}`}
							onClick={() => setOrganizeMode((value) => !value)}
						>
							{organizeMode ? 'Done' : 'Organize'}
						</button>
						<button
							type="button"
							className="btn btn-ghost btn-xs text-base-content/60"
						onClick={() => setReloadToken((value) => value + 1)}
					>
						Refresh
					</button>
				</div>
			</header>

			<div className="flex min-h-0 flex-1">
				<aside
					className={`${showingDetail ? 'hidden sm:flex' : 'flex'} min-h-0 w-full shrink-0 flex-col border-r border-base-300 bg-base-100 sm:w-72 md:w-80`}
				>
					<div className="border-b border-base-300 px-4 py-3">
						<p className="text-sm font-semibold tracking-tight text-base-content/80">Filesystem</p>
						<p className="mt-1 text-xs text-base-content/45">
							{loadingFiles ? 'Loading files...' : `${files.length} file${files.length === 1 ? '' : 's'}`}
						</p>
					</div>
					<div className="flex-1 overflow-y-auto py-2">
						{loadingFiles ? (
							<p className="px-3 py-2 font-mono text-xs text-base-content/30">Loading...</p>
						) : (
							<FileTreeView
								items={files}
								selectedId={selectedPath ?? undefined}
								dragEnabled={organizeMode}
								movingItemId={movingItemId}
								onSelect={selectFile}
								onMove={(args) => void moveFile(args)}
							/>
						)}
					</div>
				</aside>

				<section
					className={`${showingDetail ? 'flex' : 'hidden sm:flex'} min-h-0 min-w-0 flex-1 flex-col`}
				>
					<div className="border-b border-base-300 px-5 py-3">
						<div className="flex items-center gap-3">
							{showingDetail ? (
								<button
									type="button"
									className="btn btn-ghost btn-xs sm:hidden"
									onClick={() => navigate('/files')}
								>
									Back
								</button>
							) : null}
							<p className="truncate font-mono text-xs text-base-content/45">
								{selectedPath ?? 'No file selected'}
							</p>
						</div>
					</div>
					<div className="flex-1 overflow-auto bg-base-100">
						{error ? (
							<div className="p-5 text-sm text-error">{error}</div>
						) : loadingContent ? (
							<div className="p-5 text-sm text-base-content/40">Loading content...</div>
						) : selectedPath ? (
							<pre className="min-h-full whitespace-pre-wrap break-words p-5 font-mono text-sm leading-6 text-base-content/80">
								{content}
							</pre>
						) : (
							<div className="flex min-h-full items-center justify-center p-5 text-sm text-base-content/40">
								Select a file from the tree to preview it.
							</div>
						)}
					</div>
				</section>
			</div>
		</div>
	)
}

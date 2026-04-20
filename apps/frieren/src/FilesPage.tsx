import { UserButton, useAuth } from '@clerk/clerk-react'
import { FileType } from '@justfiles/fs/types'
import { type FileTreeItem, FileTreeView } from '@justfiles/ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle
} from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { navigate } from './clientRouter'
import type { Volume } from './fs'
import { createFsVolume } from './fs'

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

function dirname(path: string): string {
	const parts = path.split('/').filter(Boolean)
	if (parts.length <= 1) return '/'
	return `/${parts.slice(0, -1).join('/')}`
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
	const { getToken } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken
	const selectedPath = useMemo(() => new URLSearchParams(search).get('path'), [search])
	const selectedName = selectedPath ? basename(selectedPath) : null
	const selectedFolder = selectedPath ? dirname(selectedPath) : null
	const selectedExtension = selectedPath ? extname(selectedPath) || 'none' : null

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
		void reloadToken

		let cancelled = false

		void (async () => {
			setLoadingFiles(true)
			setError(null)
			try {
				const nextVolume = await createFsVolume(() => getTokenRef.current())
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

	const nukeAll = async () => {
		if (!window.confirm('Delete ALL files in the volume? This cannot be undone.')) return
		setError(null)
		try {
			const token = await getTokenRef.current()
			const res = await fetch('/api/nuke', {
				method: 'POST',
				headers: { Authorization: `Bearer ${token ?? ''}` }
			})
			if (!res.ok) throw new Error(`Nuke failed: ${res.status}`)
			if (selectedPath) navigate('/files', { replace: true })
			setReloadToken((value) => value + 1)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		}
	}

	const resetOnboarding = async () => {
		if (!volume) return
		if (
			!window.confirm(
				'Remove /soul.md and /profiles/user.md? The onboarding ritual will run again.'
			)
		)
			return
		setError(null)
		try {
			await volume.rm('/soul.md', { force: true })
			await volume.rm('/profiles/user.md', { force: true })
			if (selectedPath === '/soul.md' || selectedPath === '/profiles/user.md') {
				navigate('/files', { replace: true })
			}
			setReloadToken((value) => value + 1)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		}
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
		<div className="flex h-screen min-h-0 flex-col bg-background">
			<header className="border-b bg-background/95 px-4 py-3 backdrop-blur">
				<div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
					<div className="flex flex-wrap items-center gap-3">
						<Button type="button" variant="ghost" size="sm" onClick={() => navigate('/')}>
							Chat
						</Button>
						<div>
							<p className="text-sm font-semibold tracking-tight">Files</p>
							<p className="text-xs text-muted-foreground">
								{loadingFiles
									? 'Loading files…'
									: `${files.length} file${files.length === 1 ? '' : 's'}`}
							</p>
						</div>
						{organizeMode ? <Badge>Organize mode</Badge> : null}
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							type="button"
							variant={organizeMode ? 'default' : 'ghost'}
							size="sm"
							onClick={() => setOrganizeMode((value) => !value)}
						>
							{organizeMode ? 'Done' : 'Organize'}
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setReloadToken((value) => value + 1)}
						>
							Refresh
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void resetOnboarding()}
						>
							Reset
						</Button>
						<Button type="button" variant="destructive" size="sm" onClick={() => void nukeAll()}>
							Nuke
						</Button>
						<UserButton appearance={{ elements: { avatarBox: 'w-6 h-6' } }} />
					</div>
				</div>
			</header>

			<div className="flex min-h-0 flex-1 flex-col gap-4 p-4 sm:flex-row">
				<aside
					className={`${showingDetail ? 'hidden sm:flex' : 'flex'} min-h-0 w-full shrink-0 flex-col sm:w-80`}
				>
					<Card className="min-h-0 flex-1">
						<CardHeader className="gap-1">
							<CardTitle className="text-sm">Filesystem</CardTitle>
							<CardDescription>Browse, preview, and reorganize stored files.</CardDescription>
						</CardHeader>
						<CardContent className="min-h-0 flex-1 px-0">
							<ScrollArea className="h-full">
								<div className="px-2 pb-4">
									{loadingFiles ? (
										<div className="flex min-h-32 items-center justify-center">
											<Spinner className="size-5" />
										</div>
									) : (
										<FileTreeView
											items={files}
											selectedId={selectedPath ?? undefined}
											dragEnabled={organizeMode}
											movingItemId={movingItemId}
											emptyState={
												<Empty className="border-0">
													<EmptyHeader>
														<EmptyMedia variant="icon">
															<span className="font-mono text-sm">/</span>
														</EmptyMedia>
														<EmptyTitle>No files yet</EmptyTitle>
														<EmptyDescription>
															Files created during onboarding and chat will appear here.
														</EmptyDescription>
													</EmptyHeader>
												</Empty>
											}
											onSelect={selectFile}
											onMove={(args) => void moveFile(args)}
										/>
									)}
								</div>
							</ScrollArea>
						</CardContent>
					</Card>
				</aside>

				<section
					className={`${showingDetail ? 'flex' : 'hidden sm:flex'} min-h-0 min-w-0 flex-1 flex-col`}
				>
					<Card className="min-h-0 flex-1">
						<CardHeader className="gap-2">
							<div className="flex flex-wrap items-center gap-2">
								{showingDetail ? (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="sm:hidden"
										onClick={() => navigate('/files')}
									>
										Back
									</Button>
								) : null}
								<Badge variant="outline">Preview</Badge>
							</div>
							<CardTitle className="truncate text-sm">{selectedName ?? 'Select a file'}</CardTitle>
							<CardDescription className="truncate font-mono text-[11px]">
								{selectedPath ?? 'Choose a file from the tree to inspect its contents.'}
							</CardDescription>
						</CardHeader>
						<CardContent className="flex min-h-0 flex-1 flex-col gap-4">
							{error ? (
								<Alert variant="destructive">
									<AlertTitle>Unable to load file data</AlertTitle>
									<AlertDescription>{error}</AlertDescription>
								</Alert>
							) : loadingContent ? (
								<Empty className="border-0">
									<EmptyHeader>
										<EmptyTitle>Loading preview</EmptyTitle>
										<EmptyDescription>
											Reading {selectedPath ?? 'the selected file'}…
										</EmptyDescription>
									</EmptyHeader>
									<EmptyContent>
										<Spinner className="size-5" />
									</EmptyContent>
								</Empty>
							) : selectedPath ? (
								<>
									<Table>
										<TableBody>
											<TableRow>
												<TableCell className="w-28 text-muted-foreground">Name</TableCell>
												<TableCell className="font-mono">{selectedName}</TableCell>
											</TableRow>
											<TableRow>
												<TableCell className="text-muted-foreground">Folder</TableCell>
												<TableCell className="font-mono">{selectedFolder}</TableCell>
											</TableRow>
											<TableRow>
												<TableCell className="text-muted-foreground">Extension</TableCell>
												<TableCell className="font-mono">{selectedExtension}</TableCell>
											</TableRow>
										</TableBody>
									</Table>
									<ScrollArea className="min-h-0 flex-1 rounded-none border bg-muted/10">
										<pre className="min-h-full whitespace-pre-wrap break-words p-4 font-mono text-sm leading-6 text-foreground/85">
											{content}
										</pre>
									</ScrollArea>
								</>
							) : (
								<Empty className="border-0">
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<span className="font-mono text-sm">txt</span>
										</EmptyMedia>
										<EmptyTitle>No file selected</EmptyTitle>
										<EmptyDescription>
											Pick a file from the tree to preview it here.
										</EmptyDescription>
									</EmptyHeader>
								</Empty>
							)}
						</CardContent>
					</Card>
				</section>
			</div>
		</div>
	)
}

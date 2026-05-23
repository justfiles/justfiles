import { useAuth } from '@clerk/clerk-react'
import { FileType } from '@justfiles/fs/types'
import { type FileTreeItem, FileTreeView } from '@justfiles/ui'
import { useEffect, useRef, useState } from 'react'
import { createFsVolume, type Volume } from '../fs'

const decoder = new TextDecoder()

function basename(path: string): string {
	const parts = path.split('/').filter(Boolean)
	return parts[parts.length - 1] ?? ''
}

async function listFiles(volume: Volume): Promise<FileTreeItem[]> {
	const files: FileTreeItem[] = []
	await volume.scan('/', async (path, stat) => {
		if (stat.type !== FileType.Regular) return
		files.push({ id: path, path })
	})
	return files.sort((a, b) => a.path.localeCompare(b.path))
}

export function FinderApp() {
	const { getToken } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

	const [files, setFiles] = useState<FileTreeItem[]>([])
	const [selectedPath, setSelectedPath] = useState<string | null>(null)
	const [content, setContent] = useState('')
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const volumeRef = useRef<Volume | null>(null)

	useEffect(() => {
		let cancelled = false
		void (async () => {
			try {
				const volume = await createFsVolume(() => getTokenRef.current())
				const list = await listFiles(volume)
				if (cancelled) return
				volumeRef.current = volume
				setFiles(list)
			} catch (cause) {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
			} finally {
				if (!cancelled) setLoading(false)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [])

	useEffect(() => {
		const volume = volumeRef.current
		if (!volume || !selectedPath) {
			setContent('')
			return
		}
		let cancelled = false
		void (async () => {
			try {
				const bytes = await volume.readFile(selectedPath)
				if (!cancelled) setContent(decoder.decode(bytes))
			} catch (cause) {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
			}
		})()
		return () => {
			cancelled = true
		}
	}, [selectedPath])

	return (
		<div
			className="flex h-full w-full"
			style={{
				background: '#ffffff',
				color: 'var(--text)',
				fontFamily: 'var(--font-ui)',
				fontSize: 'var(--text-ui)'
			}}
		>
			<aside
				className="flex w-52 flex-none flex-col overflow-y-auto py-2"
				style={{ background: 'var(--surface)', borderRight: '1px solid var(--rule)' }}
			>
				{loading ? (
					<p className="px-3 py-1 text-xs opacity-60">Loading…</p>
				) : (
					<FileTreeView
						items={files}
						selectedId={selectedPath ?? undefined}
						onSelect={(item) => setSelectedPath(item.path)}
						emptyState={<p className="px-3 py-1 text-xs opacity-60">No files yet</p>}
					/>
				)}
			</aside>
			<section className="flex min-w-0 flex-1 flex-col">
				{selectedPath ? (
					<>
						<header
							className="flex flex-none items-center gap-2 px-3 py-2"
							style={{ borderBottom: '1px solid var(--rule)' }}
						>
							<span className="truncate font-medium">{basename(selectedPath)}</span>
							<span className="ml-auto truncate text-[11px] opacity-50">{selectedPath}</span>
						</header>
						<pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">
							{error ? <span style={{ color: '#b91c1c' }}>{error}</span> : content}
						</pre>
					</>
				) : (
					<div className="flex h-full items-center justify-center text-xs opacity-50">
						Select a file to preview
					</div>
				)}
			</section>
		</div>
	)
}

import { UserButton } from '@clerk/clerk-react'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, type RefObject, type ReactNode } from 'react'
import { FiSettings } from 'react-icons/fi'
import { AppHeader } from './AppHeader'
import { Editor, type EditorHandle } from './editor'
import type { ProseMirrorJsonDocument } from './editCache'

type Props = {
	id: string | null
	content: ProseMirrorJsonDocument | null
	onSave: (content: ProseMirrorJsonDocument) => void
	onUploadAsset?: (file: File) => Promise<string>
	resolveAssetUrl?: (src: string) => Promise<string | null>
	readAssetBlob?: (src: string) => Promise<Blob | null>
	leadingControl?: ReactNode
	headerLeft?: ReactNode
	headerRight?: ReactNode
	editorHeader?: ReactNode
	footer?: ReactNode
	isLoading?: boolean
	readOnly?: boolean
	updatedAt?: string
	editorRef?: RefObject<EditorHandle | null>
}

export function MemoryEditor({
	id,
	content,
	onSave,
	onUploadAsset,
	resolveAssetUrl,
	readAssetBlob,
	leadingControl,
	headerLeft,
	headerRight,
	editorHeader,
	footer,
	isLoading,
	readOnly,
	updatedAt,
	editorRef
}: Props) {
	const navigate = useNavigate()
	const showLoading = Boolean(isLoading)

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				navigate({ to: '/settings' })
			}
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [navigate])

	return (
		<div className="flex-1 min-h-0 flex flex-col">
			<AppHeader
				leading={leadingControl}
				title={<div className="hidden sm:block min-w-0">{headerLeft}</div>}
				trailing={
					<>
						{headerRight}
						<UserButton appearance={{ elements: { avatarBox: 'w-6 h-6' } }}>
							<UserButton.MenuItems>
								<UserButton.Action
									label="Settings"
									labelIcon={<FiSettings />}
									onClick={() => navigate({ to: '/settings' })}
								/>
							</UserButton.MenuItems>
						</UserButton>
					</>
				}
			/>
			<main className={`no-overscroll flex-1 overflow-y-auto transition-[filter] duration-150${showLoading ? ' blur-sm pointer-events-none' : ''}`}>
				<div className="safe-area-content max-w-[680px] mx-auto px-4 py-4 min-h-full flex flex-col">
					{headerLeft && <div className="sm:hidden w-full min-w-0 pb-2">{headerLeft}</div>}
					<div className="flex justify-between mb-2">
						<span className="text-[11px] text-base-content/30 font-mono">
							{updatedAt ? `updated: ${new Date(updatedAt).toLocaleString()}` : ''}
						</span>
					</div>
					{id && content ? (
						<div className="flex-1 flex flex-col min-h-0">
							{editorHeader && <div className="mb-3">{editorHeader}</div>}
							<Editor
								key={id}
								ref={editorRef}
								value={content}
								onChange={onSave}
								uploadAsset={onUploadAsset}
								resolveAssetUrl={resolveAssetUrl}
								readAssetBlob={readAssetBlob}
								readOnly={readOnly}
							/>
						</div>
					) : (
						<p className="text-sm text-base-content/50 font-mono">{showLoading ? 'Loading…' : 'Empty'}</p>
					)}
					{footer}
				</div>
			</main>
		</div>
	)
}

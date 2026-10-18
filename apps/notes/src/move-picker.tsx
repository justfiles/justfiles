import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Entry } from './app.ts'
import { isCanonicalPath, joinPath, noteTitle, parentDir } from './notes.ts'

type Destination = { path: string; create: boolean }

export function folderPathInput(input: string): string | null {
	const trimmed = input.trim().replace(/^\/+|\/+$/g, '')
	if (!trimmed) return null
	const path = `/${trimmed}`
	return isCanonicalPath(path) ? path : null
}

const folderLabel = (path: string) => (path === '/' ? 'Top level' : path.slice(1))

function MoveIcon() {
	return (
		<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
			<path
				d="M2.75 5.5A1.75 1.75 0 0 1 4.5 3.75h3l1.5 1.5h6.5a1.75 1.75 0 0 1 1.75 1.75v7.5a1.75 1.75 0 0 1-1.75 1.75h-11a1.75 1.75 0 0 1-1.75-1.75z"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinejoin="round"
			/>
			<path
				d="m9.25 9.25 2 2m0 0-2 2m2-2H6.75"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	)
}

export function MoveNoteControl(props: {
	path: string
	entries: Entry[]
	onOpen: () => void
	onMove: (dir: string, create: boolean) => Promise<boolean>
}) {
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [active, setActive] = useState(0)
	const [selected, setSelected] = useState<Destination | null>(null)
	const [moving, setMoving] = useState(false)
	const rootRef = useRef<HTMLDivElement>(null)
	const triggerRef = useRef<HTMLButtonElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const pickerId = useId()
	const currentDir = parentDir(props.path)
	const filename = props.path.slice(props.path.lastIndexOf('/') + 1)

	useEffect(() => {
		if (open) requestAnimationFrame(() => inputRef.current?.focus())
	}, [open])
	useEffect(() => {
		if (!open) return
		const outside = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
		}
		document.addEventListener('pointerdown', outside)
		return () => document.removeEventListener('pointerdown', outside)
	}, [open])

	const folders = useMemo(() => {
		const paths = props.entries
			.filter((entry) => entry.type === 'dir')
			.map((entry) => entry.path)
			.sort((a, b) => a.localeCompare(b))
		return ['/', ...paths]
	}, [props.entries])
	const destinations = useMemo(() => {
		const needle = query.trim().replace(/^\/+/, '').toLocaleLowerCase()
		const existing = folders
			.filter((path) => !needle || folderLabel(path).toLocaleLowerCase().includes(needle))
			.slice(0, 8)
			.map((path) => ({ path, create: false }))
		const typed = folderPathInput(query)
		if (typed && !folders.includes(typed)) existing.push({ path: typed, create: true })
		return existing
	}, [folders, query])
	const activeDestination = destinations[Math.min(active, destinations.length - 1)]
	const selectedTarget = selected ? joinPath(selected.path, filename) : null
	const selectedTargetExists = props.entries.some(
		(entry) => entry.type === 'file' && entry.path === selectedTarget && entry.path !== props.path
	)

	const close = (restoreFocus = false) => {
		setOpen(false)
		if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
	}
	const show = () => {
		setQuery('')
		setActive(0)
		setSelected(null)
		setOpen(true)
		props.onOpen()
	}
	const submit = async (destination: Destination | undefined | null) => {
		if (!destination || destination.path === currentDir || moving) return
		setMoving(true)
		try {
			if (await props.onMove(destination.path, destination.create)) close(true)
		} finally {
			setMoving(false)
		}
	}

	return (
		<div className="notes-move" ref={rootRef}>
			<button
				type="button"
				ref={triggerRef}
				className="notes-move-trigger"
				title="Move to folder"
				aria-label={`Move ${noteTitle(props.path)} to another folder`}
				aria-expanded={open}
				aria-controls={open ? pickerId : undefined}
				onClick={() => (open ? close() : show())}
			>
				<MoveIcon />
			</button>
			{open ? (
				<div
					className="ds-menu notes-move-picker"
					id={pickerId}
					role="dialog"
					aria-label="Move note to folder"
				>
					<strong>Move “{noteTitle(props.path)}”</strong>
					<input
						ref={inputRef}
						className="notes-move-search"
						aria-label="Destination folder"
						placeholder="Search folders or type a new path…"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value)
							setActive(0)
							setSelected(null)
						}}
						onKeyDown={(event) => {
							if (event.key === 'ArrowDown') {
								event.preventDefault()
								if (destinations.length > 0)
									setActive((index) => Math.min(index + 1, destinations.length - 1))
							} else if (event.key === 'ArrowUp') {
								event.preventDefault()
								setActive((index) => Math.max(index - 1, 0))
							} else if (event.key === 'Enter') {
								event.preventDefault()
								void submit(activeDestination)
							} else if (event.key === 'Escape') {
								event.preventDefault()
								close(true)
							}
						}}
					/>
					<div className="notes-move-options">
						{destinations.map((destination, index) => (
							<button
								type="button"
								key={`${destination.create ? 'create' : 'folder'}:${destination.path}`}
								className="ds-menu-item notes-move-option"
								data-active={index === Math.min(active, destinations.length - 1) || undefined}
								aria-pressed={selected?.path === destination.path}
								onMouseEnter={() => setActive(index)}
								onClick={() => setSelected(destination)}
							>
								<span>
									{destination.create
										? `Create “${folderLabel(destination.path)}”`
										: folderLabel(destination.path)}
								</span>
								{destination.path === currentDir ? <small>Current</small> : null}
							</button>
						))}
						{destinations.length === 0 ? (
							<div className="notes-move-empty">No matching folder — type a new path</div>
						) : null}
					</div>
					<div className="notes-move-destination">
						{selected
							? selected.path === currentDir
								? 'Already in this folder'
								: selectedTargetExists
									? 'A note with this name exists — a number will be added'
									: selectedTarget
							: 'Choose a destination folder'}
					</div>
					<div className="notes-move-actions">
						<button type="button" onClick={() => close(true)}>
							Cancel
						</button>
						<button
							type="button"
							disabled={!selected || selected.path === currentDir || moving}
							onClick={() => void submit(selected)}
						>
							{selected?.create ? 'Create and move' : 'Move'}
						</button>
					</div>
				</div>
			) : null}
		</div>
	)
}

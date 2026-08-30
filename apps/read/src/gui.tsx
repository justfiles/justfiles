import { defineReactGUI, type GUIProps } from '@justfiles/app/react'
import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Item, ReadDocument, ReadState } from './app.ts'
import { app } from './app.ts'
import './gui.css'

const initial: ReadState = {
	items: [],
	current: null,
	showRead: false,
	selection: null,
	pending: [],
	failed: [],
	revision: 0
}

const PASTE_TEXT_MIN = 200

function Read({ state, client }: GUIProps<typeof app>) {
	const model = state ?? initial
	const [input, setInput] = useState('')
	const [saving, setSaving] = useState(false)
	const [document, setDocument] = useState<ReadDocument | null>(null)
	const [loadError, setLoadError] = useState('')
	const [showList, setShowList] = useState(false)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const readerRef = useRef<HTMLElement>(null)
	const current = model.items.find((item) => item.slug === model.current) ?? null
	const unread = model.items.filter((item) => !item.read)
	const read = model.items.length - unread.length
	const listed = model.showRead ? model.items : unread
	const hidden = current?.read && !model.showRead

	useEffect(() => {
		void client.refresh({})
	}, [client, model.revision])

	useEffect(() => {
		let live = true
		setDocument(null)
		setLoadError('')
		if (!current) return () => undefined
		void client
			.load({ slug: current.slug })
			.then((next) => {
				if (live) setDocument(next)
			})
			.catch((error: unknown) => {
				if (live) setLoadError(error instanceof Error ? error.message : String(error))
			})
		return () => {
			live = false
		}
	}, [client, current])

	const pdfUrl = useMemo(() => {
		if (document?.kind !== 'pdf') return null
		const bytes = new Uint8Array(document.bytes)
		return URL.createObjectURL(new Blob([bytes.buffer], { type: 'application/pdf' }))
	}, [document])

	useEffect(
		() => () => {
			if (pdfUrl) URL.revokeObjectURL(pdfUrl)
		},
		[pdfUrl]
	)

	useEffect(() => {
		const paste = (event: ClipboardEvent) => {
			const data = event.clipboardData
			if (!data) return
			if (data.files.length) {
				const pdf = [...data.files].find(
					(file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
				)
				if (!pdf) return
				event.preventDefault()
				setSaving(true)
				void pdf
					.arrayBuffer()
					.then((bytes) =>
						client.savePdf({ name: pdf.name, data: base64(new Uint8Array(bytes)) })
					)
					.finally(() => setSaving(false))
				return
			}

			const text = data.getData('text/plain').trim()
			if (!isUrl(text) && text.length < PASTE_TEXT_MIN) return
			event.preventDefault()
			setSaving(true)
			void client.save({ input: text }).finally(() => setSaving(false))
		}
		window.addEventListener('paste', paste)
		return () => window.removeEventListener('paste', paste)
	}, [client])

	const save = async () => {
		const value = input.trim()
		if (!value || saving) return
		setSaving(true)
		setInput('')
		try {
			await client.save({ input: value })
		} finally {
			setSaving(false)
		}
	}

	const selectText = () => {
		if (!current || !readerRef.current) return
		const selection = window.getSelection()
		const node = selection?.anchorNode
		const text = node && readerRef.current.contains(node) ? selection?.toString() ?? '' : ''
		if (text.trim() !== (model.selection?.text ?? ''))
			void client.select({ slug: current.slug, text })
	}

	const pasteInstead = () => {
		setInput('')
		inputRef.current?.focus()
	}
	const open = (event: MouseEvent<HTMLAnchorElement>, url: string) => {
		if (window.parent === window) return
		event.preventDefault()
		void client.openUrl({ url })
	}

	return (
		<main className={`read-app ${current ? 'has-current' : ''} ${!current || showList ? 'show-list' : ''}`}>
			<aside className="list-pane">
				<header className="list-head">
					<div className="list-title">
						<strong>Read</strong>
						<span>{unread.length} unread</span>
						{read > 0 && (
							<button
								type="button"
								className="read-toggle"
								aria-pressed={model.showRead}
								onClick={() => void client.setShowRead({ showRead: !model.showRead })}
							>
								{read} read
							</button>
						)}
					</div>
					<div className="add-row">
						<textarea
							ref={inputRef}
							value={input}
							rows={1}
							placeholder="URL, or paste markdown"
							onChange={(event) => setInput(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter' && !event.shiftKey) {
									event.preventDefault()
									void save()
								}
							}}
						/>
						<button
							type="button"
							className="button primary"
							disabled={!input.trim() || saving}
							onClick={() => void save()}
						>
							{saving ? 'Saving' : 'Save'}
						</button>
					</div>
				</header>

				<div className="item-list">
					{model.pending.map((entry) => (
						<div className="transient" key={entry.startedAt}>
							<span className="dot pulse" />
							<div>
								<strong>{host(entry.url)}</strong>
								<span className="status fetching">fetching</span>
							</div>
						</div>
					))}
					{model.failed.map((entry) => (
						<div className="transient failed" key={entry.url}>
							<span className="dot" />
							<div>
								<strong>{host(entry.url)}</strong>
								<p title={entry.error}>{entry.error}</p>
								<div className="fail-actions">
									<button type="button" onClick={() => void client.save({ input: entry.url })}>
										Retry
									</button>
									<button type="button" onClick={pasteInstead}>
										Paste instead
									</button>
									<a href={entry.url} onClick={(event) => open(event, entry.url)}>
										Original
									</a>
									<button
										type="button"
										onClick={() => void client.dismissFailed({ url: entry.url })}
									>
										Dismiss
									</button>
								</div>
							</div>
						</div>
					))}
					{listed.map((item) => (
						<ItemRow
							key={item.slug}
							item={item}
							active={item.slug === current?.slug}
							onOpen={() => {
								setShowList(false)
								void client.open({ slug: item.slug })
							}}
						/>
					))}
					{!listed.length && !model.pending.length && !model.failed.length && (
						<div className="list-empty">
							<strong>{model.showRead ? 'Nothing saved yet' : 'All caught up'}</strong>
							<span>Save a URL, paste Markdown, or add a document in Files.</span>
						</div>
					)}
				</div>
			</aside>

			<section className="doc-pane">
				{current ? (
					<>
						<header className="doc-bar">
							<button type="button" className="back-button" onClick={() => setShowList(true)}>
								‹ Read
							</button>
							{current.source ? <span className="source">{host(current.source)}</span> : <span />}
							{hidden && <span className="hidden-note">hidden from list</span>}
							<div className="doc-actions">
								{current.source ? (
									<a
										className="button"
										href={current.source}
										target="_blank"
										rel="noreferrer"
										onClick={(event) => open(event, current.source!)}
									>
										Open original ↗
									</a>
								) : (
									<button type="button" className="button" disabled>
										Open original ↗
									</button>
								)}
								<button
									type="button"
									className="button primary"
									onClick={() =>
										void client.setRead({ slug: current.slug, read: !current.read })
									}
								>
									{current.read ? 'Mark unread' : 'Mark read'}
								</button>
								<DeleteItem
									key={current.slug}
									title={current.title}
									onDelete={() => client.remove({ slug: current.slug })}
								/>
							</div>
						</header>
						{loadError ? (
							<Empty title="Could not open this item" detail={loadError} />
						) : document?.kind === 'pdf' && pdfUrl ? (
							<iframe className="pdf" src={pdfUrl} title={current.title} />
						) : document?.kind === 'markdown' ? (
							<article ref={readerRef} className="reader" onMouseUp={selectText}>
								<div className="reader-inner">
									<header className="reader-head">
										<p className="kicker">{meta(current)}</p>
										<h1>{current.title}</h1>
									</header>
									<div className="prose">
										<ReactMarkdown
											remarkPlugins={[remarkGfm]}
											skipHtml
											components={{
												img: () => null,
												a: ({ children, href }) => {
													const url = linkUrl(href, current.source)
													return url ? (
														<a
															href={url}
															target="_blank"
															rel="noreferrer"
															onClick={(event) => open(event, url)}
														>
															{children}
														</a>
													) : (
														<>{children}</>
													)
												}
											}}
										>
											{bodyMarkdown(document.text, current.title)}
										</ReactMarkdown>
									</div>
								</div>
							</article>
						) : (
							<Empty title="Opening document" detail="Reading from the shared folder…" />
						)}
					</>
				) : (
					<Empty title="A quiet reading list" detail="Choose an item, or save something worth keeping." />
				)}
			</section>
		</main>
	)
}

function DeleteItem({
	title,
	onDelete
}: {
	title: string
	onDelete: () => Promise<unknown>
}) {
	const [confirming, setConfirming] = useState(false)
	if (!confirming)
		return (
			<button
				type="button"
				className="button remove"
				onClick={() => setConfirming(true)}
				aria-label="Delete item"
			>
				Delete
			</button>
		)

	return (
		<span className="delete-confirm" role="group" aria-label={`Delete ${title}?`}>
			<span>Delete this item?</span>
			<button type="button" className="button" onClick={() => setConfirming(false)}>
				Cancel
			</button>
			<button type="button" className="button danger" onClick={() => void onDelete()}>
				Delete
			</button>
		</span>
	)
}

function ItemRow({
	item,
	active,
	onOpen
}: {
	item: Item
	active: boolean
	onOpen: () => void
}) {
	return (
		<button
			type="button"
			className={`item ${item.read ? 'read' : ''}`}
			aria-current={active}
			onClick={onOpen}
		>
			<span className="dot" />
			<span className="item-copy">
				<strong>{item.title}</strong>
				<span>
					{age(item.savedAt)}
					{item.words > 0 && ` · ${item.words.toLocaleString()} words`}
					{item.doc.toLowerCase().endsWith('.pdf') && <em>pdf</em>}
				</span>
			</span>
		</button>
	)
}

function Empty({ title, detail }: { title: string; detail: string }) {
	return (
		<div className="empty">
			<strong>{title}</strong>
			<span>{detail}</span>
		</div>
	)
}

function host(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '')
	} catch {
		return url
	}
}

function isUrl(value: string): boolean {
	try {
		const url = new URL(value)
		return url.protocol === 'http:' || url.protocol === 'https:'
	} catch {
		return false
	}
}

function linkUrl(href: string | undefined, base: string | null): string | null {
	if (!href) return null
	try {
		const url = new URL(href, base ?? undefined)
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
	} catch {
		return null
	}
}

function base64(bytes: Uint8Array): string {
	let binary = ''
	for (let offset = 0; offset < bytes.length; offset += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
	return btoa(binary)
}

function age(time: number): string {
	const days = Math.floor((Date.now() - time) / 86_400_000)
	if (days <= 0) return 'today'
	if (days === 1) return 'yesterday'
	if (days < 7) return `${days}d ago`
	return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(time)
}

function meta(item: Item): string {
	const parts = [item.source ? host(item.source) : 'pasted', age(item.savedAt)]
	if (item.words) parts.push(`${item.words.toLocaleString()} words`)
	return parts.join(' · ')
}

function bodyMarkdown(markdown: string, title: string): string {
	const heading = markdown.match(/^#\s+(.+)\n+/)
	if (!heading?.[1]) return markdown
	const plain = heading[1].replace(/[*_`[\]]/g, '').trim()
	return plain === title ? markdown.slice(heading[0].length) : markdown
}

export const gui = defineReactGUI<typeof app>(Read)

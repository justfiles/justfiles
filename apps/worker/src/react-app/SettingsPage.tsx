import { useAuth } from '@clerk/clerk-react'
import { useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { FiChevronLeft, FiTrash2 } from 'react-icons/fi'
import {
	DAISYUI_THEMES,
	DEFAULT_DESTINATIONS,
	type Destination,
	expandTemplate,
	genId,
	loadSettings,
	saveSettings,
	TEMPLATE_TOKENS,
	type TemplateToken
} from './settings'

// ── layout primitives ──────────────────────────────────────────────────────

function Section({
	label,
	children,
	overflow = true
}: {
	label: string
	children: React.ReactNode
	overflow?: boolean
}) {
	return (
		<div className="mb-8">
			<p className="text-xs uppercase tracking-wider text-base-content/50 px-1 mb-2 font-semibold">
				{label}
			</p>
			<div
				className={`bg-base-100 rounded-xl shadow-sm border border-base-200 ${overflow ? 'overflow-hidden' : ''}`}
			>
				{children}
			</div>
		</div>
	)
}

// ── theme grid ─────────────────────────────────────────────────────────────

function ThemeGrid({ value, onChange }: { value: string; onChange: (t: string) => void }) {
	return (
		<div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-4 max-h-60 overflow-y-auto">
			{DAISYUI_THEMES.map((t) => (
				<button
					key={t}
					type="button"
					data-theme={t}
					onClick={() => onChange(t)}
					className={`outline-base-content overflow-hidden rounded-lg text-left outline-2 outline-offset-2 ${t === value ? 'outline' : ''}`}
				>
					<div className="bg-base-100 text-base-content w-full cursor-pointer font-sans">
						<div className="grid grid-cols-5 grid-rows-3">
							<div className="bg-base-200 col-start-1 row-span-2 row-start-1" />
							<div className="bg-base-300 col-start-1 row-start-3" />
							<div className="bg-base-100 col-span-4 col-start-2 row-span-3 row-start-1 flex flex-col gap-1 p-2">
								<div className="font-bold capitalize">{t}</div>
								<div className="flex flex-wrap gap-1">
									<div className="bg-primary flex aspect-square w-5 items-center justify-center rounded lg:w-6">
										<div className="text-primary-content text-sm font-bold">A</div>
									</div>
									<div className="bg-secondary flex aspect-square w-5 items-center justify-center rounded lg:w-6">
										<div className="text-secondary-content text-sm font-bold">A</div>
									</div>
									<div className="bg-accent flex aspect-square w-5 items-center justify-center rounded lg:w-6">
										<div className="text-accent-content text-sm font-bold">A</div>
									</div>
									<div className="bg-neutral flex aspect-square w-5 items-center justify-center rounded lg:w-6">
										<div className="text-neutral-content text-sm font-bold">A</div>
									</div>
								</div>
							</div>
						</div>
					</div>
				</button>
			))}
		</div>
	)
}

// ── destination row ────────────────────────────────────────────────────────

type DropdownState = { open: boolean; query: string; triggerPos: number; activeIndex: number }

function DestinationRow({
	dest,
	canDelete,
	onChange,
	onDelete
}: {
	dest: Destination
	canDelete: boolean
	onChange: (updated: Destination) => void
	onDelete: () => void
}) {
	const templateInputRef = useRef<HTMLInputElement>(null)
	const [dd, setDd] = useState<DropdownState>({
		open: false,
		query: '',
		triggerPos: -1,
		activeIndex: 0
	})
	const preview = expandTemplate(dest.pathTemplate)

	const filteredTokens = TEMPLATE_TOKENS.filter((t) => t.label.startsWith(dd.query.toLowerCase()))

	function handleTemplateChange(e: React.ChangeEvent<HTMLInputElement>) {
		const val = e.target.value
		onChange({ ...dest, pathTemplate: val })

		const cursor = e.target.selectionStart ?? val.length
		const before = val.slice(0, cursor)
		const lastOpen = before.lastIndexOf('{')

		if (lastOpen !== -1) {
			const between = before.slice(lastOpen + 1)
			if (!between.includes('}')) {
				const matches = TEMPLATE_TOKENS.filter((t) => t.label.startsWith(between.toLowerCase()))
				if (matches.length > 0) {
					setDd({ open: true, query: between, triggerPos: lastOpen, activeIndex: 0 })
					return
				}
			}
		}
		setDd((d) => ({ ...d, open: false }))
	}

	function selectToken(token: TemplateToken) {
		const el = templateInputRef.current
		if (!el) return
		const cursor = el.selectionStart ?? dest.pathTemplate.length
		const next =
			dest.pathTemplate.slice(0, dd.triggerPos) + token.token + dest.pathTemplate.slice(cursor)
		onChange({ ...dest, pathTemplate: next })
		setDd((d) => ({ ...d, open: false }))
		requestAnimationFrame(() => {
			el.focus()
			const pos = dd.triggerPos + token.token.length
			el.setSelectionRange(pos, pos)
		})
	}

	function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (!dd.open) return
		if (e.key === 'ArrowDown') {
			e.preventDefault()
			setDd((d) => ({ ...d, activeIndex: Math.min(d.activeIndex + 1, filteredTokens.length - 1) }))
		} else if (e.key === 'ArrowUp') {
			e.preventDefault()
			setDd((d) => ({ ...d, activeIndex: Math.max(d.activeIndex - 1, 0) }))
		} else if (e.key === 'Enter' || e.key === 'Tab') {
			const t = filteredTokens[dd.activeIndex]
			if (t) {
				e.preventDefault()
				selectToken(t)
			}
		} else if (e.key === 'Escape') {
			setDd((d) => ({ ...d, open: false }))
		}
	}

	return (
		<div className="px-4 py-2.5">
			{/* Name | Path | Delete */}
			<div className="flex items-center gap-2">
				<input
					type="text"
					value={dest.name}
					onChange={(e) => onChange({ ...dest, name: e.target.value })}
					placeholder="Name"
					className="w-24 shrink-0 text-sm font-medium bg-transparent outline-none placeholder:text-base-content/30"
				/>
				<span className="text-base-content/20 select-none">│</span>
				<div className="relative flex-1">
					<input
						ref={templateInputRef}
						type="text"
						value={dest.pathTemplate}
						onChange={handleTemplateChange}
						onKeyDown={handleKeyDown}
						onBlur={() => setTimeout(() => setDd((d) => ({ ...d, open: false })), 150)}
						placeholder="inbox/{timestamp}"
						spellCheck={false}
						className="w-full text-xs font-mono text-base-content/70 bg-transparent outline-none placeholder:text-base-content/30"
					/>
					{dd.open && filteredTokens.length > 0 && (
						<div className="absolute left-0 top-full mt-1 z-50 bg-base-100 border border-base-300 rounded-lg shadow-lg overflow-hidden min-w-56">
							{filteredTokens.map((t, i) => (
								<button
									key={t.token}
									type="button"
									onMouseDown={(e) => {
										e.preventDefault()
										selectToken(t)
									}}
									className={`w-full text-left px-3 py-2 flex items-baseline gap-3 transition-colors ${i === dd.activeIndex ? 'bg-base-200' : 'hover:bg-base-200'}`}
								>
									<span className="font-mono text-xs text-base-content/80 shrink-0">{t.token}</span>
									<span className="text-xs text-base-content/50">{t.description}</span>
								</button>
							))}
						</div>
					)}
				</div>
				{canDelete && (
					<button
						type="button"
						onClick={onDelete}
						className="btn btn-ghost btn-xs text-error shrink-0"
						title="Delete"
					>
						<FiTrash2 className="w-3.5 h-3.5" />
					</button>
				)}
			</div>

			{/* Preview */}
			<p className="mt-1 text-xs font-mono text-base-content/35 truncate" title={preview}>
				→ {preview}
			</p>
		</div>
	)
}

// ── main page ──────────────────────────────────────────────────────────────

export function SettingsPage() {
	const { userId } = useAuth()
	const canGoBack = useCanGoBack()
	const navigate = useNavigate()
	const router = useRouter()
	const [destinations, setDestinations] = useState(() => loadSettings(userId!).destinations)
	const [theme, setTheme] = useState(() => loadSettings(userId!).theme)
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	// Debounced persist whenever destinations change
	useEffect(() => {
		if (saveTimer.current) clearTimeout(saveTimer.current)
		saveTimer.current = setTimeout(() => {
			saveSettings({ destinations }, userId!)
		}, 300)
		return () => {
			if (saveTimer.current) clearTimeout(saveTimer.current)
		}
	}, [destinations, userId])

	function handleThemeChange(next: string) {
		setTheme(next)
		saveSettings({ theme: next }, userId!)
		document.documentElement.setAttribute('data-theme', next)
	}

	function updateDestination(updated: Destination) {
		setDestinations((prev) => prev.map((d) => (d.id === updated.id ? updated : d)))
	}

	function deleteDestination(id: string) {
		setDestinations((prev) => prev.filter((d) => d.id !== id))
	}

	function addDestination() {
		const blank: Destination = {
			id: genId(),
			name: '',
			pathTemplate: DEFAULT_DESTINATIONS[0].pathTemplate
		}
		setDestinations((prev) => [...prev, blank])
	}

	return (
		<div className="safe-area-page no-overscroll w-full h-dvh overflow-y-auto bg-base-200 text-base-content font-sans">
			{/* Nav bar */}
			<div className="navbar sticky top-0 z-10 bg-base-200/90 backdrop-blur border-b border-base-200 min-h-14">
				<div className="max-w-lg mx-auto w-full px-4 flex items-center gap-2">
					<button
						type="button"
						onClick={() => {
							if (canGoBack) {
								router.history.back()
								return
							}

							void navigate({ to: '/files', replace: true, viewTransition: true })
						}}
						className="btn btn-ghost btn-sm text-primary gap-0.5 -ml-1"
					>
						<FiChevronLeft className="w-5 h-5" />
						Back
					</button>
					<h1 className="flex-1 text-center text-base font-semibold -ml-12 pointer-events-none">
						Settings
					</h1>
				</div>
			</div>

			<div className="max-w-lg mx-auto px-4 pt-8 pb-16">
				<Section label="Appearance">
					<ThemeGrid value={theme} onChange={handleThemeChange} />
				</Section>

				<Section label="Destinations" overflow={false}>
					{destinations.map((dest, i) => (
						<div
							key={dest.id}
							className={i < destinations.length - 1 ? 'border-b border-base-200' : ''}
						>
							<DestinationRow
								dest={dest}
								canDelete={destinations.length > 1}
								onChange={updateDestination}
								onDelete={() => deleteDestination(dest.id)}
							/>
						</div>
					))}
				</Section>

				<button
					type="button"
					onClick={addDestination}
					className="btn btn-outline btn-primary w-full rounded-xl"
				>
					+ Add Destination
				</button>

				{/* Token reference */}
				<div className="mt-8">
					<p className="text-xs uppercase tracking-wider text-base-content/50 px-1 mb-2 font-semibold">
						Template tokens
					</p>
					<div className="bg-base-100 rounded-xl border border-base-200 shadow-sm overflow-hidden">
						<table className="table table-xs w-full">
							<tbody>
								{TEMPLATE_TOKENS.map((t) => (
									<tr key={t.token} className="align-top">
										<td className="font-mono text-base-content/80 whitespace-nowrap">{t.token}</td>
										<td className="text-base-content/50">{t.description}</td>
										<td className="font-mono text-base-content/50 text-right whitespace-nowrap">
											{t.example()}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>

				<Section label="About">
					<div className="flex items-center justify-between gap-4 px-4 py-3">
						<div className="min-w-0">
							<p className="text-sm font-medium text-base-content">Justfiles</p>
							<p className="text-xs text-base-content/55">App version</p>
						</div>
						<code className="shrink-0 rounded-md bg-base-200 px-2 py-1 text-xs text-base-content/70">
							v{__APP_VERSION__}
						</code>
					</div>
				</Section>
			</div>
		</div>
	)
}

import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import {
	DEFAULT_DESTINATIONS,
	TEMPLATE_TOKENS,
	type Destination,
	expandTemplate,
	genId,
	loadSettings,
	saveSettings,
} from './settings'

// ── icons ──────────────────────────────────────────────────────────────────

function ChevronLeft() {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
			<path fillRule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" />
		</svg>
	)
}

function TrashIcon() {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
			<path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 3.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clipRule="evenodd" />
		</svg>
	)
}

// ── layout primitives ──────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="mb-8">
			<p className="text-xs uppercase tracking-wider text-base-content/50 px-1 mb-2 font-semibold">{label}</p>
			<div className="bg-base-100 rounded-xl overflow-hidden shadow-sm border border-base-200">
				{children}
			</div>
		</div>
	)
}

// ── destination row ────────────────────────────────────────────────────────

function DestinationRow({
	dest,
	canDelete,
	onChange,
	onDelete,
}: {
	dest: Destination
	canDelete: boolean
	onChange: (updated: Destination) => void
	onDelete: () => void
}) {
	const templateInputRef = useRef<HTMLInputElement>(null)
	const preview = expandTemplate(dest.pathTemplate)

	function insertToken(token: string) {
		const el = templateInputRef.current
		if (!el) return
		const start = el.selectionStart ?? dest.pathTemplate.length
		const end = el.selectionEnd ?? dest.pathTemplate.length
		const next = dest.pathTemplate.slice(0, start) + token + dest.pathTemplate.slice(end)
		onChange({ ...dest, pathTemplate: next })
		requestAnimationFrame(() => {
			el.focus()
			const pos = start + token.length
			el.setSelectionRange(pos, pos)
		})
	}

	return (
		<div className="px-4 py-3.5">
			{/* Name row */}
			<div className="flex items-center gap-3 mb-3">
				<input
					type="text"
					value={dest.name}
					onChange={(e) => onChange({ ...dest, name: e.target.value })}
					placeholder="Name"
					className="flex-1 text-sm font-medium bg-transparent outline-none placeholder:text-base-content/30"
				/>
				{canDelete && (
					<button
						type="button"
						onClick={onDelete}
						className="btn btn-ghost btn-xs text-error shrink-0"
						title="Delete"
					>
						<TrashIcon />
					</button>
				)}
			</div>

			{/* Template + preview */}
			<div className="bg-base-200 rounded-lg px-3 py-2.5">
				<input
					ref={templateInputRef}
					type="text"
					value={dest.pathTemplate}
					onChange={(e) => onChange({ ...dest, pathTemplate: e.target.value })}
					placeholder="inbox/{timestamp}"
					spellCheck={false}
					className="w-full text-xs font-mono text-base-content/70 bg-transparent outline-none placeholder:text-base-content/30"
				/>
				<p className="mt-1.5 text-xs font-mono text-base-content/40 truncate" title={preview}>
					→ {preview}
				</p>
			</div>

			{/* Token chips */}
			<div className="mt-2.5 flex flex-wrap gap-1.5">
				{TEMPLATE_TOKENS.map((t) => (
					<button
						key={t.token}
						type="button"
						onClick={() => insertToken(t.token)}
						title={t.description}
						className="kbd kbd-sm font-mono cursor-pointer hover:bg-base-300 transition-colors"
					>
						{t.token}
					</button>
				))}
			</div>
		</div>
	)
}

// ── main page ──────────────────────────────────────────────────────────────

export function SettingsPage() {
	const navigate = useNavigate()
	const [destinations, setDestinations] = useState(() => loadSettings().destinations)
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	// Debounced persist whenever destinations change
	useEffect(() => {
		if (saveTimer.current) clearTimeout(saveTimer.current)
		saveTimer.current = setTimeout(() => {
			saveSettings({ destinations })
		}, 300)
		return () => {
			if (saveTimer.current) clearTimeout(saveTimer.current)
		}
	}, [destinations])

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
			pathTemplate: DEFAULT_DESTINATIONS[0].pathTemplate,
		}
		setDestinations((prev) => [...prev, blank])
	}

	return (
		<div className="w-screen min-h-screen bg-base-200 text-base-content font-sans">
			{/* Nav bar */}
			<div className="navbar sticky top-0 z-10 bg-base-200/90 backdrop-blur border-b border-base-200 min-h-14">
				<div className="max-w-lg mx-auto w-full px-4 flex items-center gap-2">
					<button
						type="button"
						onClick={() => navigate({ to: '/' })}
						className="btn btn-ghost btn-sm text-primary gap-0.5 -ml-1"
					>
						<ChevronLeft />
						Back
					</button>
					<h1 className="flex-1 text-center text-base font-semibold -ml-12 pointer-events-none">
						Settings
					</h1>
				</div>
			</div>

			<div className="max-w-lg mx-auto px-4 pt-8 pb-16">
				<Section label="Destinations">
					{destinations.map((dest, i) => (
						<div key={dest.id} className={i < destinations.length - 1 ? 'border-b border-base-200' : ''}>
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
			</div>
		</div>
	)
}

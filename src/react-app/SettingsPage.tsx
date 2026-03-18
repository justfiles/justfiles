import { useAuth } from '@clerk/clerk-react'
import { useEffect, useRef, useState } from 'react'
import { FiChevronLeft, FiTrash2 } from 'react-icons/fi'
import {
	DEFAULT_DESTINATIONS,
	TEMPLATE_TOKENS,
	type Destination,
	expandTemplate,
	genId,
	loadSettings,
	saveSettings,
} from './settings'

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
						<FiTrash2 className="w-4 h-4" />
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
	const { userId } = useAuth()
	const [destinations, setDestinations] = useState(() => loadSettings(userId!).destinations)
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
						onClick={() => window.history.back()}
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

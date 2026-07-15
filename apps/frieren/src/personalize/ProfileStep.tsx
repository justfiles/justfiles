import { type FormEvent, useState } from 'react'
import type { Volume } from '../fs'
import { PATHS } from './state'

const encoder = new TextEncoder()

const GENDER_OPTIONS = [
	{ value: 'female', label: 'Female' },
	{ value: 'male', label: 'Male' },
	{ value: 'nonbinary', label: 'Non-binary' },
	{ value: 'prefer-not-to-say', label: 'Prefer not to say' },
	{ value: 'custom', label: 'Self-describe…' }
] as const

type Draft = {
	name: string
	birthDate: string
	genderChoice: string
	genderCustom: string
}

function initialDraft(initial?: Record<string, string>): Draft {
	const gender = initial?.gender ?? ''
	const known = GENDER_OPTIONS.some((option) => option.value === gender)
	return {
		name: initial?.name ?? '',
		birthDate: initial?.birth_date ?? '',
		genderChoice: known ? gender : gender ? 'custom' : '',
		genderCustom: known ? '' : gender
	}
}

function resolveGender(draft: Draft): string {
	if (!draft.genderChoice || draft.genderChoice === 'prefer-not-to-say') return ''
	return draft.genderChoice === 'custom' ? draft.genderCustom.trim() : draft.genderChoice
}

function buildProfile(draft: Draft): string {
	const lines = [
		'---',
		'schema: frieren/user-profile/v1',
		`name: ${draft.name.trim()}`,
		`birth_date: ${draft.birthDate}`
	]
	const gender = resolveGender(draft)
	if (gender) lines.push(`gender: ${gender}`)
	lines.push('---', '')
	return lines.join('\n')
}

export function ProfileStep({
	volume,
	initial,
	onBack,
	onDone
}: {
	volume: Volume
	initial?: Record<string, string>
	onBack: () => void
	onDone: () => void
}) {
	const [draft, setDraft] = useState(() => initialDraft(initial))
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const canSave =
		draft.name.trim().length > 0 &&
		/^\d{4}-\d{2}-\d{2}$/.test(draft.birthDate) &&
		(draft.genderChoice !== 'custom' || draft.genderCustom.trim().length > 0)

	const save = async (event: FormEvent) => {
		event.preventDefault()
		if (!canSave) return
		setSaving(true)
		setError(null)
		try {
			await volume.writeFile(PATHS.profile, encoder.encode(buildProfile(draft)))
			onDone()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
			setSaving(false)
		}
	}

	return (
		<form className="frn-traveler" onSubmit={(event) => void save(event)}>
			<div className="frn-traveler-fields">
				<p>
					Tell them who walks beside them. These details help your companion know you over time.
				</p>
				<label className="frn-field">
					<span className="frn-sheet-label">Name</span>
					<input
						type="text"
						value={draft.name}
						onChange={(event) => setDraft({ ...draft, name: event.target.value })}
						required
					/>
				</label>
				<label className="frn-field">
					<span className="frn-sheet-label">Birth date</span>
					<input
						type="date"
						value={draft.birthDate}
						onChange={(event) => setDraft({ ...draft, birthDate: event.target.value })}
						required
					/>
					<em>Stored as a date, not an age.</em>
				</label>
				<label className="frn-field">
					<span className="frn-sheet-label">Gender · optional</span>
					<select
						value={draft.genderChoice}
						onChange={(event) => setDraft({ ...draft, genderChoice: event.target.value })}
					>
						<option value="">—</option>
						{GENDER_OPTIONS.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</label>
				{draft.genderChoice === 'custom' ? (
					<label className="frn-field">
						<span className="frn-sheet-label">In your own words</span>
						<input
							type="text"
							value={draft.genderCustom}
							onChange={(event) => setDraft({ ...draft, genderCustom: event.target.value })}
						/>
					</label>
				) : null}
			</div>
			<div className="frn-sheet-actions">
				<button type="button" onClick={onBack} disabled={saving}>
					Back
				</button>
				<button type="submit" className="frn-btn-primary" disabled={!canSave || saving}>
					{saving ? 'Inscribing…' : 'Inscribe the traveler'}
				</button>
			</div>
			<footer className="frn-sheet-status" data-error={error !== null}>
				<span>{error ?? 'Only what you choose to inscribe — nothing else is written.'}</span>
			</footer>
		</form>
	)
}

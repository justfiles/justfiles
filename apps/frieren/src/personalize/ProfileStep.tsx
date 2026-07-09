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

const EMPTY: Draft = { name: '', birthDate: '', genderChoice: '', genderCustom: '' }

function resolveGender(draft: Draft): string {
	if (!draft.genderChoice) return ''
	if (draft.genderChoice === 'custom') return draft.genderCustom.trim()
	if (draft.genderChoice === 'prefer-not-to-say') return ''
	return draft.genderChoice
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

export function ProfileStep({ volume, onDone }: { volume: Volume; onDone: () => void }) {
	const [draft, setDraft] = useState<Draft>(EMPTY)
	const [reviewing, setReviewing] = useState(false)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const canReview =
		draft.name.trim().length > 0 &&
		/^\d{4}-\d{2}-\d{2}$/.test(draft.birthDate) &&
		(draft.genderChoice !== 'custom' || draft.genderCustom.trim().length > 0)

	const toReview = (event: FormEvent) => {
		event.preventDefault()
		if (!canReview) return
		setReviewing(true)
	}

	const confirm = async () => {
		setSaving(true)
		setError(null)
		try {
			if (!(await volume.exists('/system/profiles'))) {
				await volume.mkdir('/system/profiles', { recursive: true })
			}
			await volume.writeFile(PATHS.profile, encoder.encode(buildProfile(draft)))
			onDone()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			setSaving(false)
		}
	}

	if (reviewing) {
		const gender = resolveGender(draft)
		return (
			<div className="frn-onb-form">
				<div className="frn-card">
					<span className="frn-badge">The Rite of Naming</span>
					<h2 className="frn-card-title">Is this you?</h2>
					<p className="frn-card-desc">Confirm what will be etched into the record.</p>

					<dl className="frn-review">
						<dt>Name</dt>
						<dd>{draft.name}</dd>
						<dt>Birth date</dt>
						<dd>{draft.birthDate}</dd>
						{gender ? (
							<>
								<dt>Gender</dt>
								<dd>{gender}</dd>
							</>
						) : null}
					</dl>

					{error ? <p className="frn-field-error">{error}</p> : null}

					<div className="frn-card-footer">
						<button
							type="button"
							className="frn-btn-block"
							onClick={() => setReviewing(false)}
							disabled={saving}
						>
							Edit
						</button>
						<button
							type="button"
							className="frn-btn-primary frn-btn-block"
							onClick={() => void confirm()}
							disabled={saving}
						>
							{saving ? 'Inscribing…' : 'Confirm'}
						</button>
					</div>
				</div>
			</div>
		)
	}

	return (
		<form className="frn-onb-form" onSubmit={toReview}>
			<div className="frn-card">
				<span className="frn-badge">The Rite of Naming</span>
				<h2 className="frn-card-title">Who walks these halls?</h2>
				<p className="frn-card-desc">A few details, so we know who you are when we meet again.</p>

				<div className="frn-field-group">
					<div className="frn-field">
						<label className="frn-field-label" htmlFor="user-profile-name">
							Name
						</label>
						<input
							id="user-profile-name"
							type="text"
							value={draft.name}
							onChange={(e) => setDraft({ ...draft, name: e.target.value })}
							required
						/>
					</div>

					<div className="frn-field">
						<label className="frn-field-label" htmlFor="user-profile-birth-date">
							Birth date
						</label>
						<input
							id="user-profile-birth-date"
							type="date"
							value={draft.birthDate}
							onChange={(e) => setDraft({ ...draft, birthDate: e.target.value })}
							required
						/>
						<p className="frn-field-desc">Stored as a date, not an age.</p>
					</div>

					<div className="frn-field">
						<span className="frn-field-label">
							Gender <span className="frn-muted">(optional)</span>
						</span>
						<select
							value={draft.genderChoice}
							onChange={(e) => setDraft({ ...draft, genderChoice: e.target.value })}
							aria-label="Gender"
						>
							<option value="">—</option>
							{GENDER_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
						{draft.genderChoice === 'custom' ? (
							<input
								type="text"
								placeholder="Describe in your own words"
								value={draft.genderCustom}
								onChange={(e) => setDraft({ ...draft, genderCustom: e.target.value })}
							/>
						) : null}
					</div>
				</div>

				<div className="frn-card-footer">
					<button type="submit" className="frn-btn-primary frn-btn-block" disabled={!canReview}>
						Review
					</button>
				</div>
			</div>
		</form>
	)
}

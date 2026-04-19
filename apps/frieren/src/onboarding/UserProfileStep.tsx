import { useState, type FormEvent } from 'react'
import type { Volume } from '../fs'
import { PATHS } from './state'

const encoder = new TextEncoder()

const GENDER_OPTIONS = [
	{ value: 'female', label: 'Female' },
	{ value: 'male', label: 'Male' },
	{ value: 'nonbinary', label: 'Non-binary' },
	{ value: 'prefer-not-to-say', label: 'Prefer not to say' },
	{ value: 'custom', label: 'Self-describe…' },
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
		`birth_date: ${draft.birthDate}`,
	]
	const gender = resolveGender(draft)
	if (gender) lines.push(`gender: ${gender}`)
	lines.push('---', '')
	return lines.join('\n')
}

export function UserProfileStep({ volume, onDone }: { volume: Volume; onDone: () => void }) {
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
			if (!(await volume.exists('/profiles'))) {
				await volume.mkdir('/profiles', { recursive: true })
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
			<div className="mx-auto flex w-full max-w-lg flex-col gap-6 p-6">
				<header className="flex flex-col gap-2 text-center">
					<span className="badge badge-outline badge-sm tracking-widest uppercase opacity-60">
						The Rite of Naming
					</span>
					<h1 className="text-2xl font-semibold">Is this you?</h1>
					<p className="text-sm text-base-content/60">
						Confirm what will be etched into the record.
					</p>
				</header>

				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-base-300 p-4 text-sm">
					<dt className="text-base-content/50">Name</dt>
					<dd className="font-medium">{draft.name}</dd>
					<dt className="text-base-content/50">Birth date</dt>
					<dd className="font-medium">{draft.birthDate}</dd>
					{gender ? (
						<>
							<dt className="text-base-content/50">Gender</dt>
							<dd className="font-medium">{gender}</dd>
						</>
					) : null}
				</dl>

				{error ? <p className="text-sm text-error">{error}</p> : null}

				<div className="flex gap-2">
					<button
						type="button"
						className="btn btn-outline flex-1"
						onClick={() => setReviewing(false)}
						disabled={saving}
					>
						Edit
					</button>
					<button
						type="button"
						className="btn btn-primary flex-1"
						onClick={() => void confirm()}
						disabled={saving}
					>
						{saving ? 'Inscribing…' : 'Confirm'}
					</button>
				</div>
			</div>
		)
	}

	return (
		<form className="mx-auto flex w-full max-w-lg flex-col gap-6 p-6" onSubmit={toReview}>
			<header className="flex flex-col gap-2 text-center">
				<span className="badge badge-outline badge-sm tracking-widest uppercase opacity-60">
					The Rite of Naming
				</span>
				<h1 className="text-2xl font-semibold">Who walks these halls?</h1>
				<p className="text-sm text-base-content/60">
					A few details, so we know who you are when we meet again.
				</p>
			</header>

			<label className="flex flex-col gap-1">
				<span className="text-sm font-medium">Name</span>
				<input
					type="text"
					className="input input-bordered"
					value={draft.name}
					onChange={(e) => setDraft({ ...draft, name: e.target.value })}
					autoFocus
					required
				/>
			</label>

			<label className="flex flex-col gap-1">
				<span className="text-sm font-medium">Birth date</span>
				<input
					type="date"
					className="input input-bordered"
					value={draft.birthDate}
					onChange={(e) => setDraft({ ...draft, birthDate: e.target.value })}
					required
				/>
				<span className="text-xs text-base-content/45">Stored as a date, not an age.</span>
			</label>

			<label className="flex flex-col gap-1">
				<span className="text-sm font-medium">
					Gender <span className="text-base-content/45">(optional)</span>
				</span>
				<select
					className="select select-bordered"
					value={draft.genderChoice}
					onChange={(e) => setDraft({ ...draft, genderChoice: e.target.value })}
				>
					<option value="">—</option>
					{GENDER_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
				{draft.genderChoice === 'custom' ? (
					<input
						type="text"
						className="input input-bordered mt-2"
						placeholder="Describe in your own words"
						value={draft.genderCustom}
						onChange={(e) => setDraft({ ...draft, genderCustom: e.target.value })}
					/>
				) : null}
			</label>

			<button type="submit" className="btn btn-primary" disabled={!canReview}>
				Review
			</button>
		</form>
	)
}

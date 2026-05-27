import { type FormEvent, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle
} from '@/components/ui/card'
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
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
			<div className="mx-auto w-full max-w-lg p-6">
				<Card>
					<CardHeader>
						<Badge variant="outline" className="mb-2 tracking-[0.2em] uppercase">
							The Rite of Naming
						</Badge>
						<CardTitle>Is this you?</CardTitle>
						<CardDescription>Confirm what will be etched into the record.</CardDescription>
					</CardHeader>

					<CardContent className="space-y-4">
						<dl className="grid gap-3 rounded-none border border-border bg-muted/20 p-4 sm:grid-cols-[8rem_1fr] sm:gap-x-4">
							<dt className="text-muted-foreground">Name</dt>
							<dd className="font-medium text-foreground">{draft.name}</dd>
							<dt className="text-muted-foreground">Birth date</dt>
							<dd className="font-medium text-foreground">{draft.birthDate}</dd>
							{gender ? (
								<>
									<dt className="text-muted-foreground">Gender</dt>
									<dd className="font-medium text-foreground">{gender}</dd>
								</>
							) : null}
						</dl>

						<FieldError>{error}</FieldError>
					</CardContent>

					<CardFooter className="flex-col gap-2 sm:flex-row">
						<Button
							type="button"
							variant="outline"
							className="w-full flex-1"
							onClick={() => setReviewing(false)}
							disabled={saving}
						>
							Edit
						</Button>
						<Button
							type="button"
							className="w-full flex-1"
							onClick={() => void confirm()}
							disabled={saving}
						>
							{saving ? 'Inscribing…' : 'Confirm'}
						</Button>
					</CardFooter>
				</Card>
			</div>
		)
	}

	return (
		<form className="mx-auto w-full max-w-lg p-6" onSubmit={toReview}>
			<Card>
				<CardHeader>
					<Badge variant="outline" className="mb-2 tracking-[0.2em] uppercase">
						The Rite of Naming
					</Badge>
					<CardTitle>Who walks these halls?</CardTitle>
					<CardDescription>
						A few details, so we know who you are when we meet again.
					</CardDescription>
				</CardHeader>

				<CardContent>
					<FieldGroup>
						<Field>
							<FieldLabel htmlFor="user-profile-name">Name</FieldLabel>
							<Input
								id="user-profile-name"
								type="text"
								value={draft.name}
								onChange={(e) => setDraft({ ...draft, name: e.target.value })}
								autoFocus
								required
							/>
						</Field>

						<Field>
							<FieldLabel htmlFor="user-profile-birth-date">Birth date</FieldLabel>
							<Input
								id="user-profile-birth-date"
								type="date"
								value={draft.birthDate}
								onChange={(e) => setDraft({ ...draft, birthDate: e.target.value })}
								required
							/>
							<FieldDescription>Stored as a date, not an age.</FieldDescription>
						</Field>

						<FieldSet>
							<FieldLegend variant="label" className="mb-0">
								Gender <span className="text-muted-foreground">(optional)</span>
							</FieldLegend>
							<FieldGroup className="gap-3">
								<Field>
									<NativeSelect
										value={draft.genderChoice}
										onChange={(e) => setDraft({ ...draft, genderChoice: e.target.value })}
										aria-label="Gender"
										className="w-full"
									>
										<NativeSelectOption value="">—</NativeSelectOption>
										{GENDER_OPTIONS.map((option) => (
											<NativeSelectOption key={option.value} value={option.value}>
												{option.label}
											</NativeSelectOption>
										))}
									</NativeSelect>
								</Field>

								{draft.genderChoice === 'custom' ? (
									<Field>
										<FieldLabel htmlFor="user-profile-gender-custom">
											Describe in your own words
										</FieldLabel>
										<Input
											id="user-profile-gender-custom"
											type="text"
											placeholder="Describe in your own words"
											value={draft.genderCustom}
											onChange={(e) => setDraft({ ...draft, genderCustom: e.target.value })}
										/>
									</Field>
								) : null}
							</FieldGroup>
						</FieldSet>
					</FieldGroup>
				</CardContent>

				<CardFooter>
					<Button type="submit" className="w-full" disabled={!canReview}>
						Review
					</Button>
				</CardFooter>
			</Card>
		</form>
	)
}

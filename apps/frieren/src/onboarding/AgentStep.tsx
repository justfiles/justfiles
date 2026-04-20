import { useAuth } from '@clerk/clerk-react'
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
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import teacherImage from '../assets/frieren.avif'
import assistantImage from '../assets/heiter.avif'
import companionImage from '../assets/himmel.jpg'
import type { Volume } from '../fs'
import { PATHS } from './state'

const encoder = new TextEncoder()

type Archetype = 'teacher' | 'companion' | 'assistant'

const ARCHETYPES: {
	id: Archetype
	title: string
	tagline: string
	blurb: string
	image: string
}[] = [
	{
		id: 'teacher',
		title: 'Teacher',
		tagline: 'Leads you to your own answers.',
		blurb:
			'Patient and knowledgeable. Guides through questions rather than giving answers. Celebrates the moment of realisation.',
		image: teacherImage
	},
	{
		id: 'companion',
		title: 'Companion',
		tagline: 'Beside you, not above you.',
		blurb:
			'A peer. Warm, attentive, loyal. Faces things alongside you rather than solving them for you. Remembers what matters.',
		image: companionImage
	},
	{
		id: 'assistant',
		title: 'Assistant',
		tagline: 'Gets things done.',
		blurb:
			'Task-oriented and reliable. Organised and proactive. Anticipates what you need. Clear, brief, on-point.',
		image: assistantImage
	}
]

const GENDER_OPTIONS = [
	{ value: 'female', label: 'Female' },
	{ value: 'male', label: 'Male' },
	{ value: 'nonbinary', label: 'Non-binary' },
	{ value: 'none', label: 'None' }
] as const

type Draft = {
	name: string
	gender: string
	archetype: Archetype | null
}

const EMPTY: Draft = { name: '', gender: '', archetype: null }

type UserCtx = { userAge?: number; userGender?: string }

function buildSoulFile(draft: Draft, body: string): string {
	const lines = ['---', 'schema: frieren/agent-soul/v1', `agent_name: ${draft.name.trim()}`]
	if (draft.gender && draft.gender !== 'none') lines.push(`agent_gender: ${draft.gender}`)
	lines.push(`archetype: ${draft.archetype}`, '---', '', body.trim(), '')
	return lines.join('\n')
}

export function AgentStep({
	volume,
	userCtx,
	onDone
}: {
	volume: Volume
	userCtx: UserCtx
	onDone: () => void
}) {
	const { getToken } = useAuth()
	const [draft, setDraft] = useState<Draft>(EMPTY)
	const [soulText, setSoulText] = useState('')
	const [generating, setGenerating] = useState(false)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const canSubmit = draft.name.trim().length > 0 && draft.archetype !== null
	const selectedArchetype =
		draft.archetype === null
			? null
			: (ARCHETYPES.find((archetype) => archetype.id === draft.archetype) ?? null)

	const generate = async (archetype: Archetype) => {
		if (!draft.name.trim()) return
		setDraft({ ...draft, archetype })
		setGenerating(true)
		setSoulText('')
		setError(null)
		try {
			const token = await getToken()
			const res = await fetch('/api/onboarding/soul', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${token ?? ''}`
				},
				body: JSON.stringify({
					agentName: draft.name.trim(),
					agentGender: draft.gender && draft.gender !== 'none' ? draft.gender : undefined,
					archetype,
					userAge: userCtx.userAge,
					userGender: userCtx.userGender
				})
			})
			if (!res.ok) throw new Error(`Summoning failed: ${res.status}`)
			const data = (await res.json()) as { text: string }
			setSoulText(data.text)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			setGenerating(false)
		}
	}

	const pickArchetype = (event: FormEvent) => {
		event.preventDefault()
		if (!canSubmit || !draft.archetype) return
		void generate(draft.archetype)
	}

	const regenerate = () => {
		if (!draft.archetype) return
		void generate(draft.archetype)
	}

	const confirm = async () => {
		if (!draft.archetype) return
		setSaving(true)
		setError(null)
		try {
			await volume.writeFile(PATHS.soul, encoder.encode(buildSoulFile(draft, soulText)))
			onDone()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			setSaving(false)
		}
	}

	if (soulText || generating) {
		return (
			<div className="mx-auto w-full max-w-3xl p-6">
				<Card>
					<CardHeader>
						<Badge variant="outline" className="mb-2 tracking-[0.2em] uppercase">
							The Summoning
						</Badge>
						<CardTitle>{draft.name.trim()} takes shape.</CardTitle>
						<CardDescription>
							Read their soul. Adjust anything that does not ring true.
						</CardDescription>
					</CardHeader>

					<CardContent className="space-y-4">
						{generating ? (
							<div className="flex min-h-72 flex-col items-center justify-center gap-3 border border-dashed border-border bg-muted/20 px-6 py-10 text-center text-xs text-muted-foreground">
								<div className="flex items-center gap-2">
									<span className="size-2 animate-pulse rounded-full bg-current" />
									<span className="size-2 animate-pulse rounded-full bg-current [animation-delay:120ms]" />
									<span className="size-2 animate-pulse rounded-full bg-current [animation-delay:240ms]" />
								</div>
								<p>Summoning…</p>
							</div>
						) : (
							<Field>
								<FieldLabel htmlFor="agent-soul-text">Soul</FieldLabel>
								<Textarea
									id="agent-soul-text"
									className="min-h-72 font-mono leading-6"
									value={soulText}
									onChange={(e) => setSoulText(e.target.value)}
								/>
								<FieldDescription>
									Edit the draft directly before binding it to your companion.
								</FieldDescription>
							</Field>
						)}

						<FieldError>{error}</FieldError>
					</CardContent>

					<CardFooter className="flex-col gap-2 sm:flex-row">
						<Button
							type="button"
							variant="outline"
							className="w-full sm:w-auto"
							onClick={() => {
								setSoulText('')
								setDraft({ ...draft, archetype: null })
							}}
							disabled={generating || saving}
						>
							Back
						</Button>
						<Button
							type="button"
							variant="ghost"
							className="w-full sm:w-auto"
							onClick={regenerate}
							disabled={generating || saving}
						>
							Regenerate
						</Button>
						<Button
							type="button"
							className="w-full sm:ml-auto sm:w-auto"
							onClick={() => void confirm()}
							disabled={generating || saving || !soulText.trim()}
						>
							{saving ? 'Binding…' : 'Bind'}
						</Button>
					</CardFooter>
				</Card>
			</div>
		)
	}

	return (
		<form className="mx-auto w-full max-w-3xl p-6" onSubmit={pickArchetype}>
			<Card>
				<CardHeader>
					<Badge variant="outline" className="mb-2 tracking-[0.2em] uppercase">
						The Summoning
					</Badge>
					<CardTitle>Call your companion.</CardTitle>
					<CardDescription>
						Give them a name, a shape, and the stance they should take.
					</CardDescription>
				</CardHeader>

				<CardContent>
					<FieldGroup>
						<Field>
							<FieldLabel htmlFor="agent-name">Name</FieldLabel>
							<Input
								id="agent-name"
								type="text"
								value={draft.name}
								onChange={(e) => setDraft({ ...draft, name: e.target.value })}
								autoFocus
								required
							/>
						</Field>

						<Field>
							<FieldLabel htmlFor="agent-gender">
								Gender <span className="text-muted-foreground">(optional)</span>
							</FieldLabel>
							<NativeSelect
								id="agent-gender"
								value={draft.gender}
								onChange={(e) => setDraft({ ...draft, gender: e.target.value })}
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

						<FieldSet>
							<FieldLegend variant="label" className="mb-0">
								Archetype
							</FieldLegend>
							<FieldDescription>
								Choose the stance they should take when they speak to you.
							</FieldDescription>
							<div className="grid gap-3 md:grid-cols-3">
								{ARCHETYPES.map((archetype) => {
									const selected = draft.archetype === archetype.id
									return (
										<label key={archetype.id} className="block">
											<input
												type="radio"
												name="agent-archetype"
												value={archetype.id}
												checked={selected}
												onChange={() => setDraft({ ...draft, archetype: archetype.id })}
												className="sr-only"
											/>
											<div
												className={cn(
													'relative overflow-hidden border bg-muted/40 transition-colors',
													selected
														? 'border-primary bg-primary/5 ring-1 ring-primary/30'
														: 'border-border hover:border-foreground/20 hover:bg-muted/30'
												)}
											>
												<img
													src={archetype.image}
													alt={`${archetype.title} placeholder`}
													className={cn(
														'aspect-[3/4] h-full w-full object-cover transition-[filter,transform] duration-300',
														selected ? 'grayscale-0' : 'grayscale contrast-110'
													)}
												/>
												<div className="absolute inset-x-0 top-0 flex justify-end p-3">
													<span
														aria-hidden="true"
														className={cn(
															'size-3 shrink-0 rounded-full border bg-background/80 backdrop-blur-sm',
															selected ? 'border-primary bg-primary' : 'border-muted-foreground/40'
														)}
													/>
												</div>
											</div>
										</label>
									)
								})}
							</div>
							{selectedArchetype ? (
								<Card size="sm" className="border-primary/40 bg-primary/5">
									<CardHeader>
										<CardTitle>{selectedArchetype.title}</CardTitle>
										<CardDescription>{selectedArchetype.tagline}</CardDescription>
									</CardHeader>
									<CardContent>
										<p className="text-xs/relaxed text-muted-foreground">
											{selectedArchetype.blurb}
										</p>
									</CardContent>
								</Card>
							) : null}
						</FieldSet>

						<FieldError>{error}</FieldError>
					</FieldGroup>
				</CardContent>

				<CardFooter>
					<Button type="submit" className="w-full sm:w-auto" disabled={!canSubmit}>
						Summon
					</Button>
				</CardFooter>
			</Card>
		</form>
	)
}

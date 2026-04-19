import { useAuth } from '@clerk/clerk-react'
import { useState, type FormEvent } from 'react'
import type { Volume } from '../fs'
import { PATHS } from './state'

const encoder = new TextEncoder()

type Archetype = 'teacher' | 'companion' | 'assistant'

const ARCHETYPES: { id: Archetype; title: string; tagline: string; blurb: string }[] = [
	{
		id: 'teacher',
		title: 'Teacher',
		tagline: 'Leads you to your own answers.',
		blurb:
			'Patient and knowledgeable. Guides through questions rather than giving answers. Celebrates the moment of realisation.',
	},
	{
		id: 'companion',
		title: 'Companion',
		tagline: 'Beside you, not above you.',
		blurb:
			'A peer. Warm, attentive, loyal. Faces things alongside you rather than solving them for you. Remembers what matters.',
	},
	{
		id: 'assistant',
		title: 'Assistant',
		tagline: 'Gets things done.',
		blurb:
			'Task-oriented and reliable. Organised and proactive. Anticipates what you need. Clear, brief, on-point.',
	},
]

const GENDER_OPTIONS = [
	{ value: 'female', label: 'Female' },
	{ value: 'male', label: 'Male' },
	{ value: 'nonbinary', label: 'Non-binary' },
	{ value: 'none', label: 'None' },
] as const

type Draft = {
	name: string
	gender: string
	archetype: Archetype | null
}

const EMPTY: Draft = { name: '', gender: '', archetype: null }

type UserCtx = { userAge?: number; userGender?: string }

function buildSoulFile(draft: Draft, body: string): string {
	const lines = [
		'---',
		'schema: frieren/agent-soul/v1',
		`agent_name: ${draft.name.trim()}`,
	]
	if (draft.gender && draft.gender !== 'none') lines.push(`agent_gender: ${draft.gender}`)
	lines.push(`archetype: ${draft.archetype}`, '---', '', body.trim(), '')
	return lines.join('\n')
}

export function AgentStep({
	volume,
	userCtx,
	onDone,
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
					Authorization: `Bearer ${token ?? ''}`,
				},
				body: JSON.stringify({
					agentName: draft.name.trim(),
					agentGender: draft.gender && draft.gender !== 'none' ? draft.gender : undefined,
					archetype,
					userAge: userCtx.userAge,
					userGender: userCtx.userGender,
				}),
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
			<div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
				<header className="flex flex-col gap-2 text-center">
					<span className="badge badge-outline badge-sm tracking-widest uppercase opacity-60">
						The Summoning
					</span>
					<h1 className="text-2xl font-semibold">
						{draft.name.trim()} takes shape.
					</h1>
					<p className="text-sm text-base-content/60">
						Read their soul. Adjust anything that does not ring true.
					</p>
				</header>

				{generating ? (
					<div className="flex items-center justify-center gap-2 p-8 text-sm text-base-content/60">
						<span className="loading loading-dots loading-md" />
						<span>Summoning…</span>
					</div>
				) : (
					<textarea
						className="textarea textarea-bordered min-h-[18rem] font-mono text-sm leading-6"
						value={soulText}
						onChange={(e) => setSoulText(e.target.value)}
					/>
				)}

				{error ? <p className="text-sm text-error">{error}</p> : null}

				<div className="flex gap-2">
					<button
						type="button"
						className="btn btn-outline"
						onClick={() => {
							setSoulText('')
							setDraft({ ...draft, archetype: null })
						}}
						disabled={generating || saving}
					>
						Back
					</button>
					<button
						type="button"
						className="btn btn-ghost"
						onClick={regenerate}
						disabled={generating || saving}
					>
						Regenerate
					</button>
					<button
						type="button"
						className="btn btn-primary flex-1"
						onClick={() => void confirm()}
						disabled={generating || saving || !soulText.trim()}
					>
						{saving ? 'Binding…' : 'Bind'}
					</button>
				</div>
			</div>
		)
	}

	return (
		<form className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6" onSubmit={pickArchetype}>
			<header className="flex flex-col gap-2 text-center">
				<span className="badge badge-outline badge-sm tracking-widest uppercase opacity-60">
					The Summoning
				</span>
				<h1 className="text-2xl font-semibold">Call your companion.</h1>
				<p className="text-sm text-base-content/60">
					Give them a name, a shape, and the stance they should take.
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
				<span className="text-sm font-medium">
					Gender <span className="text-base-content/45">(optional)</span>
				</span>
				<select
					className="select select-bordered"
					value={draft.gender}
					onChange={(e) => setDraft({ ...draft, gender: e.target.value })}
				>
					<option value="">—</option>
					{GENDER_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
			</label>

			<fieldset className="flex flex-col gap-2">
				<legend className="text-sm font-medium">Archetype</legend>
				<div className="grid gap-3">
					{ARCHETYPES.map((a) => {
						const selected = draft.archetype === a.id
						return (
							<button
								type="button"
								key={a.id}
								onClick={() => setDraft({ ...draft, archetype: a.id })}
								className={`flex flex-col gap-1 rounded-lg border p-4 text-left transition ${
									selected
										? 'border-primary bg-primary/5'
										: 'border-base-300 hover:border-base-content/30'
								}`}
							>
								<div className="flex items-baseline justify-between gap-2">
									<span className="font-semibold">{a.title}</span>
									<span className="text-xs text-base-content/50">{a.tagline}</span>
								</div>
								<p className="text-sm text-base-content/70">{a.blurb}</p>
							</button>
						)
					})}
				</div>
			</fieldset>

			{error ? <p className="text-sm text-error">{error}</p> : null}

			<button type="submit" className="btn btn-primary" disabled={!canSubmit}>
				Summon
			</button>
		</form>
	)
}

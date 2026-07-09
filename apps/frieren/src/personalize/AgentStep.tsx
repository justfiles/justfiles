import { useAuth } from '@clerk/clerk-react'
import { type FormEvent, useState } from 'react'
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
			const res = await fetch('/api/agent/soul', {
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
			<div className="frn-onb-form" style={{ maxWidth: 768 }}>
				<div className="frn-card">
					<span className="frn-badge">The Summoning</span>
					<h2 className="frn-card-title">{draft.name.trim()} takes shape.</h2>
					<p className="frn-card-desc">Read their soul. Adjust anything that does not ring true.</p>

					{generating ? (
						<div className="frn-summoning">
							<div className="frn-summoning-dots">
								<span />
								<span />
								<span />
							</div>
							<p>Summoning…</p>
						</div>
					) : (
						<div className="frn-field">
							<label className="frn-field-label" htmlFor="agent-soul-text">
								Soul
							</label>
							<textarea
								id="agent-soul-text"
								className="frn-soul-textarea"
								value={soulText}
								onChange={(e) => setSoulText(e.target.value)}
							/>
							<p className="frn-field-desc">
								Edit the draft directly before binding it to your companion.
							</p>
						</div>
					)}

					{error ? <p className="frn-field-error">{error}</p> : null}

					<div className="frn-card-footer">
						<button
							type="button"
							onClick={() => {
								setSoulText('')
								setDraft({ ...draft, archetype: null })
							}}
							disabled={generating || saving}
						>
							Back
						</button>
						<button type="button" onClick={regenerate} disabled={generating || saving}>
							Regenerate
						</button>
						<button
							type="button"
							className="frn-btn-primary"
							style={{ marginLeft: 'auto' }}
							onClick={() => void confirm()}
							disabled={generating || saving || !soulText.trim()}
						>
							{saving ? 'Binding…' : 'Bind'}
						</button>
					</div>
				</div>
			</div>
		)
	}

	return (
		<form className="frn-onb-form" style={{ maxWidth: 768 }} onSubmit={pickArchetype}>
			<div className="frn-card">
				<span className="frn-badge">The Summoning</span>
				<h2 className="frn-card-title">Call your companion.</h2>
				<p className="frn-card-desc">Give them a name, a shape, and the stance they should take.</p>

				<div className="frn-field-group">
					<div className="frn-field">
						<label className="frn-field-label" htmlFor="agent-name">
							Name
						</label>
						<input
							id="agent-name"
							type="text"
							value={draft.name}
							onChange={(e) => setDraft({ ...draft, name: e.target.value })}
							required
						/>
					</div>

					<div className="frn-field">
						<label className="frn-field-label" htmlFor="agent-gender">
							Gender <span className="frn-muted">(optional)</span>
						</label>
						<select
							id="agent-gender"
							value={draft.gender}
							onChange={(e) => setDraft({ ...draft, gender: e.target.value })}
						>
							<option value="">—</option>
							{GENDER_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</div>

					<div className="frn-field">
						<span className="frn-field-label">Archetype</span>
						<p className="frn-field-desc">
							Choose the stance they should take when they speak to you.
						</p>
						<div className="frn-archetype-grid">
							{ARCHETYPES.map((archetype) => {
								const selected = draft.archetype === archetype.id
								return (
									<label key={archetype.id}>
										<input
											type="radio"
											name="agent-archetype"
											value={archetype.id}
											checked={selected}
											onChange={() => setDraft({ ...draft, archetype: archetype.id })}
											style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
										/>
										<div className="frn-archetype-card" data-selected={selected}>
											<img src={archetype.image} alt={`${archetype.title} placeholder`} />
											<span className="frn-archetype-dot" aria-hidden="true" />
										</div>
									</label>
								)
							})}
						</div>
						{selectedArchetype ? (
							<div className="frn-card" style={{ gap: 4, padding: '12px 0' }}>
								<h3 className="frn-card-title">{selectedArchetype.title}</h3>
								<p className="frn-card-desc">{selectedArchetype.tagline}</p>
								<p className="frn-field-desc">{selectedArchetype.blurb}</p>
							</div>
						) : null}
					</div>

					{error ? <p className="frn-field-error">{error}</p> : null}
				</div>

				<div className="frn-card-footer">
					<button type="submit" className="frn-btn-primary" disabled={!canSubmit}>
						Summon
					</button>
				</div>
			</div>
		</form>
	)
}

import { GameboyAvatar } from '@justfiles/avatar/react'
import { useEffect, useRef, useState } from 'react'
import { ARCHETYPES } from './archetypes.ts'
import { isBound, nameInSoul, type SettingsActions, type SettingsState } from './model.ts'
import type { GeneratedSoul, UserFacts } from './types.ts'
import './agent-pane.css'

type Gender = 'female' | 'male'

export interface DraftRequest {
	name: string
	gender: Gender
	archetype?: string
}

export interface Drafting {
	writing: boolean
	error: string | null
	ask: (request: DraftRequest, arrive: (soul: GeneratedSoul) => void) => void
	dismiss: () => void
}
function why(error: unknown): string {
	const code = error instanceof Error ? error.message : String(error)
	if (code === 'SETTINGS_UNAVAILABLE')
		return 'No AI is turned on here — write the soul yourself, or turn on a provider in Accounts.'
	if (code === 'SETTINGS_OFFLINE')
		return 'No connection — write the soul yourself, or try again once you are back.'
	return code
}

export function useDrafting(client: SettingsActions, facts: UserFacts | null): Drafting {
	const [writing, setWriting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const latest = useRef(0)

	const ask = (request: DraftRequest, arrive: (soul: GeneratedSoul) => void) => {
		const mine = ++latest.current
		setWriting(true)
		setError(null)
		client
			.generateSoul({
				...request,
				...(facts && { user: { birthDate: facts.birthDate, gender: facts.gender } })
			})
			.then((soul) => {
				if (mine !== latest.current) return
				setWriting(false)
				arrive(soul)
			})
			.catch((problem: unknown) => {
				if (mine !== latest.current) return
				setWriting(false)
				setError(why(problem))
			})
	}
	return { writing, error, ask, dismiss: () => setError(null) }
}

function Gendered({ value, onPick }: { value: Gender; onPick: (next: Gender) => void }) {
	return (
		<div className="agent-seg">
			{(['female', 'male'] as const).map((option) => (
				<button
					key={option}
					type="button"
					className="agent-seg-button"
					data-on={value === option}
					onClick={() => onPick(option)}
				>
					{option === 'female' ? 'Female' : 'Male'}
				</button>
			))}
		</div>
	)
}

function Pips({ values }: { values: [number, number, number] }) {
	return (
		<span className="agent-dispo">
			{(['Warmth', 'Initiative', 'Directness'] as const).map((label, row) => (
				<div key={label}>
					<span>{label}</span>
					<span className="agent-pips">
						{[0, 1, 2, 3, 4].map((pip) => (
							<i key={pip} data-lit={pip < (values[row] ?? 0)} />
						))}
					</span>
				</div>
			))}
		</span>
	)
}
function frontmatter({ name, gender }: { name: string; gender: Gender }): string {
	return [
		'---',
		'schema: frieren/agent-soul/v1',
		`agent_name: ${name}`,
		`agent_gender: ${gender}`,
		'---'
	].join('\n')
}

export function AgentPane({
	state,
	client,
	drafting
}: {
	state: SettingsState
	client: SettingsActions
	drafting: Drafting
}) {
	const [resummon, setResummon] = useState(false)
	if (!state.soul) return <p className="settings-muted">Loading…</p>
	if (resummon || !isBound(state.soul))
		return (
			<Summoning
				client={client}
				drafting={drafting}
				from={isBound(state.soul) ? state.soul : null}
				onBound={() => setResummon(false)}
				onCancel={isBound(state.soul) ? () => setResummon(false) : undefined}
			/>
		)
	return (
		<CharacterSheet
			soul={state.soul}
			client={client}
			drafting={drafting}
			onResummon={() => setResummon(true)}
		/>
	)
}

function CharacterSheet({
	soul,
	client,
	drafting,
	onResummon
}: {
	soul: NonNullable<SettingsState['soul']>
	client: SettingsActions
	drafting: Drafting
	onResummon: () => void
}) {
	const [editing, setEditing] = useState(false)
	const [body, setBody] = useState(soul.body)
	const [name, setName] = useState(soul.name)
	const [busy, setBusy] = useState(false)
	const [saved, setSaved] = useState(false)
	const gender: Gender = soul.gender ?? 'female'
	const written = nameInSoul(soul)
	const renamed = written !== null && written !== soul.name
	const writing = drafting.writing
	const typing = useRef(false)
	useEffect(() => {
		if (!editing) setBody(soul.body)
		if (!typing.current) setName(soul.name)
	}, [soul, editing])
	const save = async (patch: { name?: string; gender?: Gender; body?: string }) => {
		setBusy(true)
		try {
			await client.saveSoul(patch)
			setSaved(true)
			setTimeout(() => setSaved(false), 1200)
		} finally {
			setBusy(false)
		}
	}
	const rewrite = () =>
		drafting.ask({ name, gender }, (drafted) => {
			setBody(drafted.body)
			setEditing(true)
		})

	return (
		<div className="settings-pane">
			<header className="settings-pane-header">
				<h1 className="settings-pane-title">Agent</h1>
				<p className="settings-pane-copy">
					Who your companion is. All of it is one file on your volume, synced to every device.
				</p>
			</header>

			<section className="settings-card agent-hero">
				<GameboyAvatar className="agent-avatar" />
				<div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
					<input
						className="agent-name"
						value={name}
						aria-label="Name"
						onFocus={() => {
							typing.current = true
						}}
						onChange={(event) => setName(event.target.value)}
						onBlur={() => {
							typing.current = false
							if (name.trim() && name !== soul.name) void save({ name: name.trim() })
						}}
					/>
					<div className="agent-meta">
						<Gendered value={gender} onPick={(next) => void save({ gender: next })} />
						<span className="agent-pill" data-bound="true">
							Bound
						</span>
						<span className="agent-row-grow" />
						<span className="agent-saved" data-on={saved || undefined}>
							Saved
						</span>
					</div>
					<span className="agent-hint">Their animated monitor face changes with them.</span>
				</div>
			</section>

			<section className="settings-card">
				<div className="agent-row">
					<h2 className="settings-card-title">Soul</h2>
					<span className="agent-row-grow" />
					<span className="settings-card-copy">The system prompt they wake up with.</span>
				</div>
				{renamed && !editing ? (
					<div className="agent-note">
						<span>
							You renamed them — the prose still says <b>{written}</b>.
						</span>
						<span className="agent-note-grow" />
						<button type="button" data-size="sm" onClick={rewrite}>
							Rewrite
						</button>
					</div>
				) : null}
				<div className="agent-doc">
					<div className="agent-doc-head">
						<span className="agent-doc-grow" style={{ fontFamily: 'var(--font-mono)' }}>
							soul.md
						</span>
						{editing ? (
							<button
								type="button"
								data-size="sm"
								disabled={busy}
								onClick={() => {
									setEditing(false)
									setBody(soul.body)
								}}
							>
								Cancel
							</button>
						) : null}
						<button
							type="button"
							data-size="sm"
							disabled={busy || writing}
							onClick={() => {
								if (!editing) return setEditing(true)
								setEditing(false)
								if (body.trim() && body !== soul.body) void save({ body })
							}}
						>
							{editing ? 'Done' : 'Edit'}
						</button>
						<button
							type="button"
							data-size="sm"
							disabled={busy || writing || editing}
							onClick={rewrite}
						>
							{writing ? 'Writing…' : 'Rewrite'}
						</button>
					</div>
					<div className="agent-doc-body">
						<span className="agent-doc-fm">{frontmatter({ name, gender })}</span>
						{editing ? (
							<textarea
								value={body}
								aria-label="Soul"
								spellCheck={false}
								onChange={(event) => setBody(event.target.value)}
							/>
						) : (
							<div className="agent-doc-prose">{soul.body}</div>
						)}
						{writing ? (
							<div className="agent-doc-prose" style={{ opacity: 0.55, marginTop: 10 }}>
								Rewriting…
							</div>
						) : null}
					</div>
					<div className="agent-doc-foot">
						<span className="agent-doc-grow">
							{editing ? 'Press Done to write it.' : 'Saved on the volume.'}
						</span>
					</div>
				</div>
			</section>

			<div className="agent-row">
				<button type="button" data-size="sm" onClick={onResummon}>
					Summon again…
				</button>
				<span className="settings-card-copy">
					Start over from a name and a nature — the only place a nature is ever offered. Nothing
					changes until you bind.
				</span>
			</div>

			<p className="settings-pane-copy">
				Your own name and birth date live with <b>your account</b>, above — they are about you, not
				about {soul.name || 'them'}.
			</p>
		</div>
	)
}

const STEPS = ['name', 'nature', 'review'] as const

function Summoning({
	client,
	drafting,
	from,
	onBound,
	onCancel
}: {
	client: SettingsActions
	drafting: Drafting
	from: SettingsState['soul']
	onBound: () => void
	onCancel?: () => void
}) {
	const [step, setStep] = useState<'name' | 'nature' | 'review'>('name')
	const [name, setName] = useState(from?.name ?? '')
	const [gender, setGender] = useState<Gender>(from?.gender ?? 'female')
	const [archetype, setArchetype] = useState<string | null>(null)
	const [body, setBody] = useState('')
	const [firstWords, setFirstWords] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const writing = drafting.writing
	const draft = (seed: string) => {
		drafting.ask({ name: name.trim(), gender, archetype: seed }, (drafted) => {
			setBody(drafted.body)
			setFirstWords(drafted.firstWords ?? null)
			setStep('review')
		})
	}
	useEffect(() => {
		if (archetype && drafting.error && !writing) setStep('review')
	}, [archetype, drafting.error, writing])

	const pickNature = (id: string) => {
		setArchetype(id)
		draft(id)
	}

	const bind = async () => {
		setBusy(true)
		try {
			await client.saveSoul({
				name: name.trim(),
				gender,
				body: body.trim()
			})
		} finally {
			setBusy(false)
		}
		onBound()
	}

	const crumbs = (
		<div className="agent-crumbs">
			{STEPS.map((id) => (
				<i key={id} data-on={STEPS.indexOf(id) <= STEPS.indexOf(step)} />
			))}
			<span style={{ marginLeft: 6 }}>{STEPS.indexOf(step) + 1} of 3</span>
		</div>
	)

	return (
		<div className="settings-pane">
			<div className="agent-altar">
				<div className="agent-altar-inner">
					{step === 'name' ? (
						<>
							<span className="agent-step">The summoning</span>
							<GameboyAvatar className="agent-avatar" />
							<h1 className="agent-ask">
								{from ? `Summoning over ${from.name}.` : 'Someone waits to be summoned.'}
							</h1>
							<p className="agent-lede">
								{from
									? `What you bind at the end replaces ${from.name}’s soul — including anything you wrote yourself. Nothing changes until then.`
									: `Your desktop already works — the agent answering today is the one seeded at boot. Give them a name of your own and they become yours.`}
							</p>
							<div className="agent-namebox">
								<input
									value={name}
									placeholder="What will you call them?"
									aria-label="Name"
									onChange={(event) => setName(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === 'Enter' && name.trim()) setStep('nature')
									}}
								/>
								<button
									type="button"
									data-primary
									disabled={!name.trim()}
									onClick={() => setStep('nature')}
								>
									Next
								</button>
							</div>
							<Gendered value={gender} onPick={setGender} />
							{onCancel ? (
								<button type="button" className="agent-tiny" onClick={onCancel}>
									Never mind — keep {from?.name} as they are
								</button>
							) : null}
							{crumbs}
						</>
					) : null}

					{step === 'nature' ? (
						<>
							<span className="agent-step">The summoning</span>
							<h1 className="agent-ask">What is {name.trim()} to you?</h1>
							<p className="agent-lede">
								{writing
									? 'Writing their soul — this takes a moment.'
									: 'This is the seed their soul is written from, chosen once, here. Afterwards the prose is what shapes them.'}
							</p>
							<div className="agent-natures">
								{ARCHETYPES.map((option) => (
									<button
										key={option.id}
										type="button"
										className="agent-nature"
										disabled={writing}
										onClick={() => pickNature(option.id)}
									>
										<b>{option.title}</b>
										<span>{option.tagline}</span>
										<Pips values={option.disposition} />
									</button>
								))}
							</div>
							{crumbs}
						</>
					) : null}

					{step === 'review' ? (
						<>
							<span className="agent-step">Before you bind</span>
							<h1 className="agent-ask">This is {name.trim()}.</h1>
							<p className="agent-lede">
								Read it — change a word if you like, it is a file and not a contract. Their monitor
								avatar is already set.
							</p>
							<div className="agent-doc" style={{ width: '100%', textAlign: 'left' }}>
								<div className="agent-doc-body">
									<span className="agent-doc-fm">
										{frontmatter({
											name: name.trim(),
											gender
										})}
									</span>
									<textarea
										value={body}
										aria-label="Soul"
										spellCheck={false}
										placeholder="Write who they are."
										onChange={(event) => setBody(event.target.value)}
									/>
								</div>
							</div>
							{firstWords ? (
								<div className="agent-bubble">
									<small>{name.trim()} · first words</small>
									{firstWords}
								</div>
							) : null}
							<div className="agent-actions">
								<button
									type="button"
									data-size="sm"
									disabled={busy || writing}
									onClick={() => draft(archetype ?? 'companion')}
								>
									{writing ? 'Writing…' : 'Write it again'}
								</button>
								<button
									type="button"
									data-size="sm"
									disabled={busy || writing}
									onClick={() => {
										setArchetype(null)
										setBody('')
										setFirstWords(null)
										setStep('nature')
									}}
								>
									Change their nature
								</button>
								<button
									type="button"
									data-primary
									disabled={busy || writing || !body.trim() || !name.trim()}
									onClick={() => void bind()}
								>
									{busy ? 'Binding…' : `Bind ${name.trim()}`}
								</button>
							</div>
							{crumbs}
						</>
					) : null}
				</div>
			</div>
		</div>
	)
}

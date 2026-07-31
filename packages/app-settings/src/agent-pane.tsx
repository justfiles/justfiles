import type { Client } from '@justfiles/app'
import { injectStyle } from '@justfiles/app/browser'
import { type ChangeEvent, type DragEvent, useEffect, useRef, useState } from 'react'
import { isBound, nameInSoul, type SettingsApp, type SettingsState } from './app.ts'
import { ARCHETYPES, archetypeOf, faceOf, SPIRIT_ART } from './archetypes.ts'
import { pngUrl, squarePng } from './squarePng.ts'

// The Agent pane: who your companion is, and nothing else (your own name and birth date
// live with your account — they are facts about you). Two states, one pane:
//
//   UNBOUND — still wearing the soul seeded at boot. The pane never shows a form full of
//   someone else's defaults; it runs THE SUMMONING: a name, a nature, then the soul
//   drafted in front of you, kept only when you say so.
//
//   BOUND — the character sheet: the avatar (click or drop a photo on it), the name, the
//   gender, and the soul as a document you can edit or have rewritten.
//
// A NATURE IS A SEED, NOT A SETTING. It is chosen once, in the summoning, and afterwards
// shown read-only: the prose is the character, and re-picking an archetype would either
// do nothing or quietly contradict the soul on screen. The route back is deliberate —
// "Summon again", which replaces the soul. The capability enforces this (`writeSoul`
// preserves the recorded archetype unless the summoning passes one), so this pane cannot
// drift from the file it is showing.
//
// The one drift left is a RENAME: the prose opens "You are Fern…". The pane says so and
// offers one Rewrite. It never rewrites prose because a field changed.

injectStyle(
	`
.settings-card.agent-hero { display: grid; grid-template-columns: auto 1fr; gap: 18px; align-items: center; }
.agent-face { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.agent-drop { position: relative; width: 96px; height: 96px; padding: 0; overflow: hidden; display: grid; place-items: center; border: 1px solid var(--rule); border-radius: 12px; background: color-mix(in srgb, var(--window-bg) 92%, black); }
.agent-drop img { width: 100%; height: 100%; object-fit: cover; }
.agent-drop-veil { position: absolute; inset: 0; display: grid; place-items: center; align-content: center; gap: 2px; font-size: 10.5px; color: #fff; background: rgba(0,0,0,0.45); opacity: 0; transition: opacity 0.15s; }
.agent-drop:hover .agent-drop-veil, .agent-drop[data-over="true"] .agent-drop-veil { opacity: 1; }
.agent-drop[data-over="true"] { border: 2px dashed var(--focus); }
.agent-name { font: inherit; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; width: 100%; padding: 3px 6px; margin-left: -6px; color: inherit; background: transparent; border: 1px solid transparent; border-radius: 7px; }
.agent-name:hover { border-color: var(--rule); background: var(--window-bg); }
.agent-name:focus { border-color: var(--focus); background: var(--window-bg); outline: none; }
.agent-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; opacity: 0.65; }
.agent-hint { font-size: 11px; opacity: 0.5; }
.agent-tiny { padding: 0; border: 0; background: transparent; color: inherit; font: inherit; font-size: 11px; opacity: 0.6; text-decoration: underline; }
.agent-row > button { white-space: nowrap; }

.agent-seg { display: inline-flex; overflow: hidden; border: 1px solid var(--rule); border-radius: 7px; background: var(--window-bg); }
.agent-seg button { padding: 4px 14px; font-size: 12px; border: 0; border-right: 1px solid var(--rule); background: transparent; color: inherit; }
.agent-seg button:last-child { border-right: 0; }
.agent-seg button[data-on="true"] { background: var(--focus); color: var(--on-focus); }

.agent-pill { font-size: 10px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 8px; border: 1px solid var(--rule); border-radius: 999px; opacity: 0.75; }
.agent-pill[data-bound="true"] { border-color: color-mix(in srgb, var(--focus) 55%, var(--rule)); color: var(--focus); opacity: 1; }

.agent-note { display: flex; align-items: center; gap: 10px; padding: 9px 12px; font-size: 12px; border-radius: 8px; border: 1px solid color-mix(in srgb, #b26a00 45%, var(--window-bg)); background: color-mix(in srgb, #b26a00 12%, var(--window-bg)); color: color-mix(in srgb, #b26a00 78%, var(--text)); }
.agent-note-grow { flex: 1; }

.agent-doc { display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--rule); border-radius: 9px; background: var(--window-bg); }
.agent-doc-head, .agent-doc-foot { display: flex; align-items: center; gap: 8px; padding: 7px 10px; font-size: 11px; background: var(--surface); }
.agent-doc-head { border-bottom: 1px solid var(--rule); }
.agent-doc-foot { border-top: 1px solid var(--rule); font-size: 11.5px; }
.agent-doc-grow { flex: 1; opacity: 0.6; }
.agent-doc-body { position: relative; max-height: 280px; overflow-y: auto; padding: 14px 16px; font-size: 12.5px; line-height: 1.55; }
.agent-doc-body[data-proposal="true"] { background: color-mix(in srgb, var(--focus) 7%, var(--window-bg)); }
.agent-doc-fm { display: block; margin-bottom: 10px; font-family: var(--font-mono); font-size: 11px; white-space: pre-wrap; opacity: 0.4; }
.agent-doc-prose { white-space: pre-wrap; }
.agent-doc-body textarea { width: 100%; min-height: 220px; font: inherit; font-size: 12.5px; line-height: 1.55; color: inherit; background: transparent; border: 0; outline: none; resize: vertical; }

/* the summoning */
.agent-altar { display: grid; place-items: center; padding: 20px 0 30px; }
.agent-altar-inner { display: flex; flex-direction: column; align-items: center; gap: 15px; width: 100%; max-width: 560px; text-align: center; }
.agent-altar-portrait { position: relative; width: 132px; height: 132px; border-radius: 18px; }
.agent-altar-portrait img { width: 100%; height: 100%; object-fit: cover; }
.agent-altar-portrait[data-dim="true"] img { filter: grayscale(1); opacity: 0.4; }
.agent-ring { position: absolute; inset: -10px; border: 2px dashed color-mix(in srgb, var(--focus) 70%, transparent); border-radius: 50%; animation: agent-spin 3.2s linear infinite; pointer-events: none; }
@keyframes agent-spin { to { transform: rotate(360deg); } }
.agent-step { font-size: 10px; font-weight: 650; letter-spacing: 0.2em; text-transform: uppercase; opacity: 0.45; }
.agent-ask { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: -0.02em; }
.agent-lede { margin: 0; max-width: 400px; font-size: 12px; line-height: 1.5; opacity: 0.55; }
.agent-namebox { display: flex; gap: 8px; width: min(340px, 100%); }
.agent-namebox input { flex: 1; font: inherit; font-size: 16px; text-align: center; padding: 9px 12px; color: inherit; background: var(--window-bg); border: 1px solid var(--rule); border-radius: 9px; }
.agent-namebox input:focus { border-color: var(--focus); outline: none; }
.agent-natures { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; width: 100%; }
.agent-nature { display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 14px 10px 15px; text-align: center; border: 1px solid var(--rule); border-radius: 12px; background: var(--window-bg); color: inherit; }
.agent-nature:hover { border-color: var(--focus); background: color-mix(in srgb, var(--focus) 6%, var(--window-bg)); }
.agent-nature img { width: 72px; height: 72px; }
.agent-nature b { font-size: 13.5px; }
.agent-nature span { font-size: 11.5px; line-height: 1.35; opacity: 0.6; }
.agent-dispo { display: grid; gap: 3px; width: 100%; margin-top: 2px; }
.agent-dispo div { display: flex; align-items: center; justify-content: space-between; font-size: 10px; opacity: 0.6; }
.agent-pips { display: inline-flex; gap: 3px; }
.agent-pips i { width: 10px; height: 4px; border-radius: 2px; background: var(--rule); }
.agent-pips i[data-lit="true"] { background: color-mix(in srgb, var(--focus) 75%, var(--text)); }
.agent-bubble { position: relative; width: 100%; padding: 12px 14px; text-align: left; font-size: 13px; line-height: 1.5; background: var(--surface); border: 1px solid var(--rule); border-radius: 12px; }
.agent-bubble small { display: block; margin-bottom: 5px; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; opacity: 0.45; }
.agent-crumbs { display: flex; align-items: center; gap: 6px; font-size: 11px; opacity: 0.5; }
.agent-crumbs i { width: 5px; height: 5px; border-radius: 50%; background: var(--rule); }
.agent-crumbs i[data-on="true"] { background: var(--focus); }
.agent-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.agent-row { display: flex; align-items: center; gap: 12px; }
.agent-row-grow { flex: 1; }
.agent-saved { font-size: 11px; opacity: 0; transition: opacity 0.2s; color: color-mix(in srgb, #047857 80%, var(--text)); }
.agent-saved[data-on="true"] { opacity: 1; }
`,
	'app-settings-agent'
)

const CAMERA = (
	<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
		<title>Choose a photo</title>
		<path d="M9 3h6l1 2h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3l1-2Zm3 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z" />
	</svg>
)

type Gender = 'female' | 'male'

// The face on the volume, as a blob URL. Kept out of reducer state (that is JSON, and it
// replicates): the bytes ride back from a procedure and become a URL here. Shared with the
// sidebar row, which wears the same face.
export function useAvatar(client: Client<SettingsApp>, revision: number) {
	const [photo, setPhoto] = useState<string | null>(null)
	useEffect(() => {
		// `revision` is why this runs again: a write here, or a sync from another device.
		// Nothing else in state moves when only the avatar file does.
		void revision
		let url: string | null = null
		void client
			.readAvatar({})
			.then((bytes) => {
				url = bytes ? pngUrl(bytes) : null
				setPhoto(url)
			})
			.catch(() => setPhoto(null))
		return () => {
			if (url) URL.revokeObjectURL(url)
		}
	}, [client, revision])
	return photo
}

// Click it or drop an image on it: the portrait IS the avatar editor. There is one avatar
// for now — expression faces are still derived from it downstream, and emotion editing
// will expand this control rather than need a section of its own.
function AvatarDrop({
	face,
	size = 'sheet',
	dim,
	busy,
	onPick,
	onError
}: {
	face: string
	size?: 'sheet' | 'altar'
	dim?: boolean
	busy?: boolean
	onPick: (bytes: Uint8Array<ArrayBuffer>) => void
	onError?: (message: string) => void
}) {
	const input = useRef<HTMLInputElement>(null)
	const [over, setOver] = useState(false)

	const take = async (file?: File | null) => {
		if (!file) return
		if (!file.type.startsWith('image/')) return onError?.('That is not an image.')
		const source = URL.createObjectURL(file)
		try {
			onPick(await squarePng(source))
		} catch (error) {
			onError?.(error instanceof Error ? error.message : String(error))
		} finally {
			URL.revokeObjectURL(source)
		}
	}
	const drop = (event: DragEvent<HTMLButtonElement>) => {
		event.preventDefault()
		setOver(false)
		void take(event.dataTransfer?.files?.[0])
	}
	return (
		<>
			<button
				type="button"
				className={size === 'altar' ? 'agent-drop agent-altar-portrait' : 'agent-drop'}
				data-over={over || undefined}
				data-dim={dim || undefined}
				disabled={busy}
				title="Click, or drop an image here"
				onClick={() => input.current?.click()}
				onDragOver={(event) => {
					event.preventDefault()
					setOver(true)
				}}
				onDragLeave={() => setOver(false)}
				onDrop={drop}
			>
				<img src={face} alt="" />
				<span className="agent-drop-veil">
					{CAMERA}
					<span>{over ? 'Drop to use' : 'Use a photo'}</span>
				</span>
			</button>
			<input
				ref={input}
				type="file"
				accept="image/*"
				hidden
				onChange={(event: ChangeEvent<HTMLInputElement>) => void take(event.target.files?.[0])}
			/>
		</>
	)
}

function Gendered({ value, onPick }: { value: Gender; onPick: (next: Gender) => void }) {
	return (
		<div className="agent-seg">
			{(['female', 'male'] as const).map((option) => (
				<button
					key={option}
					type="button"
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

// The frontmatter the write will actually produce, shown dimmed above the prose so the
// document on screen is the document on disk.
function frontmatter({
	name,
	gender,
	archetype,
	variant
}: {
	name: string
	gender: Gender
	archetype: string | null
	variant: string | null
}): string {
	const lines = [
		'---',
		'schema: frieren/agent-soul/v1',
		`agent_name: ${name}`,
		`agent_gender: ${gender}`
	]
	if (archetype) lines.push(`archetype: ${archetype}`)
	if (variant) lines.push(`avatar_variant: ${variant}`)
	lines.push('---')
	return lines.join('\n')
}

export function AgentPane({
	state,
	client
}: {
	state: SettingsState
	client: Client<SettingsApp>
}) {
	const [resummon, setResummon] = useState(false)
	// A proposal outliving its context is `guiStarted`'s to clear, NOT this component's:
	// switching to Accounts unmounts this pane, so discarding on mount here threw away a
	// draft the user had merely stepped away from — including one that finished while
	// they were looking at another pane.

	// `soul` is null only before the first read lands.
	if (!state.soul) return <p className="settings-muted">Loading…</p>
	// "Summon again" is GUI-local on purpose: re-entering the ritual destroys nothing, and
	// the write only happens at Bind — so there is no "unbind" method and no confirmation
	// for a step that has not touched the volume.
	if (resummon || !isBound(state.soul))
		return (
			<Summoning
				state={state}
				client={client}
				from={resummon ? state.soul : null}
				onCancel={resummon ? () => setResummon(false) : undefined}
			/>
		)
	return (
		<CharacterSheet
			state={state}
			soul={state.soul}
			client={client}
			onResummon={() => {
				// A Rewrite proposal on the sheet is prose for the name and nature they have
				// NOW — it is not this ritual's draft, and the ritual adopts what it finds.
				// Left standing it would open on the review step over someone else's words.
				if (state.proposal) void client.discardProposal({})
				setResummon(true)
			}}
		/>
	)
}

function CharacterSheet({
	state,
	soul,
	client,
	onResummon
}: {
	state: SettingsState
	// Proved non-null by `AgentPane`, and passed rather than re-derived so every hook
	// below runs unconditionally.
	soul: NonNullable<SettingsState['soul']>
	client: Client<SettingsApp>
	onResummon: () => void
}) {
	const nature = archetypeOf(soul.archetype)
	// The art actually on screen is the recorded VARIANT, which a soul written before
	// variants existed simply lacks — then the default face is what renders.
	const worn = archetypeOf(soul.avatarVariant)
	// Re-read the face whenever the avatar file changes — a write here, or a sync from
	// another device. The soul is not the signal: it does not move when a photo is added
	// or dropped.
	const photo = useAvatar(client, state.avatarRevision)
	const [editing, setEditing] = useState(false)
	const [body, setBody] = useState(soul.body)
	const [name, setName] = useState(soul.name)
	const [busy, setBusy] = useState(false)
	const [saved, setSaved] = useState(false)
	const [faceError, setFaceError] = useState<string | null>(null)
	const gender: Gender = soul.gender ?? 'female'
	const written = nameInSoul(soul)
	const renamed = written !== null && written !== soul.name

	// The volume is the truth: a sync (or a rewrite) replaces what is on screen unless the
	// user is mid-edit, in which case their draft stands until they press Done.
	useEffect(() => {
		if (!editing) setBody(soul.body)
		setName(soul.name)
	}, [soul, editing])

	const save = async (patch: { name?: string; gender?: Gender; body?: string }, flash = true) => {
		setBusy(true)
		try {
			await client.saveSoul({
				name: patch.name ?? name,
				gender: patch.gender ?? gender,
				body: patch.body ?? body
			})
			if (flash) {
				setSaved(true)
				setTimeout(() => setSaved(false), 1200)
			}
		} finally {
			setBusy(false)
		}
	}

	const rewrite = () =>
		void client.generateSoul({
			name,
			gender,
			// A rewrite reuses the recorded seed — the pane offers no way to change it.
			archetype: soul.archetype ?? 'companion'
		})

	const proposal = state.proposal
	return (
		<div className="settings-pane">
			<header className="settings-pane-header">
				<h1 className="settings-pane-title">Agent</h1>
				<p className="settings-pane-copy">
					Who your companion is. All of it is one file on your volume, synced to every device.
				</p>
			</header>

			<section className="settings-card agent-hero">
				<div className="agent-face">
					<AvatarDrop
						face={faceOf(photo, soul.avatarVariant)}
						busy={busy}
						onError={setFaceError}
						onPick={(bytes) => {
							setFaceError(null)
							client
								.saveAvatar({ bytes })
								.catch((error: unknown) =>
									setFaceError(error instanceof Error ? error.message : String(error))
								)
						}}
					/>
					{photo ? (
						<button
							type="button"
							className="agent-tiny"
							onClick={() => void client.saveAvatar({ bytes: null })}
						>
							Use their own art
						</button>
					) : (
						<span className="agent-hint">click or drop</span>
					)}
					{faceError ? <span className="settings-card-error">{faceError}</span> : null}
				</div>
				<div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
					<input
						className="agent-name"
						value={name}
						aria-label="Name"
						onChange={(event) => setName(event.target.value)}
						onBlur={() => {
							if (name.trim() && name !== soul.name) void save({ name: name.trim() })
						}}
					/>
					<div className="agent-meta">
						<Gendered value={gender} onPick={(next) => void save({ gender: next })} />
						<span className="agent-pill" data-bound="true">
							Bound
						</span>
						<span>{nature ? nature.title : 'no recorded nature'}</span>
						<span className="agent-row-grow" />
						<span className="agent-saved" data-on={saved || undefined}>
							Saved
						</span>
					</div>
					<span className="agent-hint">
						{photo
							? 'Your photo is stored on the volume.'
							: `Their face is the ${worn ? `${worn.title.toLowerCase()} ` : 'default '}art — a choice, not bytes. Drop a photo on it to use your own.`}
					</span>
				</div>
			</section>

			<section className="settings-card">
				<div className="agent-row">
					<h2 className="settings-card-title">Soul</h2>
					<span className="agent-row-grow" />
					<span className="settings-card-copy">The system prompt they wake up with.</span>
				</div>
				{renamed && !proposal ? (
					<div className="agent-note">
						<span>
							You renamed them — the prose still says <b>{written}</b>.
						</span>
						<span className="agent-note-grow" />
						{state.canGenerate ? (
							<button type="button" className="settings-small-button" onClick={rewrite}>
								Rewrite
							</button>
						) : null}
					</div>
				) : null}
				<div className="agent-doc">
					<div className="agent-doc-head">
						<span className="agent-doc-grow" style={{ fontFamily: 'var(--font-mono)' }}>
							soul.md
						</span>
						<button
							type="button"
							className="settings-small-button"
							disabled={busy || state.generating}
							onClick={() => {
								if (!editing) return setEditing(true)
								setEditing(false)
								if (body.trim() && body !== soul.body) void save({ body })
							}}
						>
							{editing ? 'Done' : 'Edit'}
						</button>
						{state.canGenerate ? (
							<button
								type="button"
								className="settings-small-button"
								disabled={busy || state.generating || editing}
								onClick={rewrite}
							>
								{state.generating ? 'Writing…' : 'Rewrite'}
							</button>
						) : null}
					</div>
					<div className="agent-doc-body" data-proposal={proposal ? 'true' : undefined}>
						<span className="agent-doc-fm">
							{frontmatter({
								name,
								gender,
								archetype: soul.archetype,
								variant: photo ? null : soul.avatarVariant
							})}
						</span>
						{editing ? (
							<textarea
								value={body}
								aria-label="Soul"
								spellCheck={false}
								onChange={(event) => setBody(event.target.value)}
							/>
						) : (
							<div className="agent-doc-prose">{proposal?.body ?? soul.body}</div>
						)}
						{state.generating ? (
							<div className="agent-doc-prose" style={{ opacity: 0.55, marginTop: 10 }}>
								Rewriting…
							</div>
						) : null}
					</div>
					{proposal ? (
						<div className="agent-doc-foot">
							<span className="agent-doc-grow">
								A new soul, from the same name and nature. Nothing is saved yet.
							</span>
							<button
								type="button"
								className="settings-small-button"
								onClick={() => void client.discardProposal({})}
							>
								Discard
							</button>
							<button
								type="button"
								data-primary
								disabled={busy}
								onClick={() => void save({ body: proposal.body })}
							>
								Use this
							</button>
						</div>
					) : (
						<div className="agent-doc-foot">
							<span className="agent-doc-grow">
								{editing ? 'Press Done to write it.' : 'Saved on the volume.'}
							</span>
						</div>
					)}
				</div>
				{nature ? (
					<p className="settings-card-copy">
						Seeded from the <b>{nature.title}</b> nature at the summoning. That was the seed for the
						first draft; the prose above is what shapes them now, so there is nothing to pick again
						here.
					</p>
				) : null}
			</section>

			<div className="agent-row">
				<button type="button" className="settings-small-button" onClick={onResummon}>
					Summon again…
				</button>
				<span className="settings-card-copy">
					Start over from a name and a nature — the only place a nature is ever chosen. Nothing
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

// ── the summoning ─────────────────────────────────────────────────────────
// One question at a time, in the same pane, in a real window: a name, then a nature, then
// the soul drafted in front of you. Nothing is written until "Bind" — including the photo,
// which is why the draft carries bytes.

const STEPS = ['name', 'nature', 'review'] as const

function Summoning({
	state,
	client,
	from,
	onCancel
}: {
	state: SettingsState
	client: Client<SettingsApp>
	// The soul being replaced, when this is "summon again": the ritual starts from the name
	// they already have rather than from nothing.
	from: SettingsState['soul']
	onCancel?: () => void
}) {
	const [step, setStep] = useState<'name' | 'nature' | 'review'>('name')
	const [name, setName] = useState(from?.name ?? '')
	const [gender, setGender] = useState<Gender>(from?.gender ?? 'female')
	const [archetype, setArchetype] = useState<string | null>(null)
	const [photo, setPhoto] = useState<{ bytes: Uint8Array<ArrayBuffer>; url: string } | null>(null)
	const [body, setBody] = useState('')
	const [busy, setBusy] = useState(false)
	// Whether a draft is this ritual's to adopt. `state.proposal` is one slot shared with
	// the character sheet's Rewrite, and adopting one written for the agent being REPLACED
	// would skip the name and the nature and then bind that prose under the old archetype.
	// So the ritual only ever takes a draft it asked for.
	const [asked, setAsked] = useState(false)
	const nature = archetypeOf(archetype)

	// The draft arrives through reducer state (it cost a model call, so it survives a
	// reload): showing it IS the review step.
	useEffect(() => {
		if (asked && state.proposal) {
			setBody(state.proposal.body)
			setStep('review')
		}
	}, [asked, state.proposal])

	// A draft that is not coming must never strand the ritual on the picker, where the only
	// affordance is to ask again. Two ways that happens: no generator at all (a signed-out
	// Mac — known up front, or only once a call comes back CAPABILITY_UNAVAILABLE), and a
	// call that simply failed (offline, an upstream 500). Either way the nature is picked
	// and the soul is a file you can write yourself, so go where the editor is — the review
	// step also carries "Write it again", so nothing is lost by arriving early.
	// (`generateSoul` clears `error` as it starts, so an error standing with nothing in
	// flight, after we asked, is our attempt's.)
	useEffect(() => {
		if (!archetype) return
		if (!state.canGenerate || (asked && state.error && !state.generating)) setStep('review')
	}, [archetype, asked, state.canGenerate, state.error, state.generating])

	// Asking is what makes the next draft ours to show.
	const draft = (seed: string) => {
		setAsked(true)
		void client.generateSoul({ name: name.trim(), gender, archetype: seed })
	}

	const pickNature = (id: string) => {
		setArchetype(id)
		if (state.canGenerate) draft(id)
	}

	const bind = async () => {
		setBusy(true)
		try {
			// Always written, because binding is also how "summon again" lands: with no photo
			// this CLEARS a previous one, or the newly bound agent would keep wearing the old
			// face instead of the art the review promised (`avatar.png` beats `avatar_variant`).
			await client.saveAvatar({ bytes: photo?.bytes ?? null })
			await client.saveSoul({
				name: name.trim(),
				gender,
				body: body.trim(),
				// The one place an archetype is ever passed.
				archetype: archetype ?? undefined
			})
		} finally {
			setBusy(false)
		}
	}

	const crumbs = (
		<div className="agent-crumbs">
			{STEPS.map((id) => (
				<i key={id} data-on={STEPS.indexOf(id) <= STEPS.indexOf(step)} />
			))}
			<span style={{ marginLeft: 6 }}>{STEPS.indexOf(step) + 1} of 3</span>
		</div>
	)

	const art = photo?.url ?? nature?.art ?? SPIRIT_ART
	const writing = state.generating

	return (
		<div className="settings-pane">
			<div className="agent-altar">
				<div className="agent-altar-inner">
					{step === 'review' ? (
						<AvatarDrop
							face={art}
							size="altar"
							busy={busy}
							onPick={(bytes) => setPhoto({ bytes, url: pngUrl(bytes) })}
						/>
					) : (
						<span className="agent-drop agent-altar-portrait" data-dim="true">
							<img src={art} alt="" />
							{writing ? <span className="agent-ring" /> : null}
						</span>
					)}

					{step === 'name' ? (
						<>
							<span className="agent-step">The summoning</span>
							<h1 className="agent-ask">
								{from ? `Summoning over ${from.name}.` : 'Someone waits to be summoned.'}
							</h1>
							<p className="agent-lede">
								{from
									? `What you bind at the end replaces ${from.name}’s soul — including anything you wrote yourself. Nothing changes until then.`
									: `Your desktop already works — an agent named ${state.soul?.name || 'Kodama'} answers today. Give them a name of your own and they become yours.`}
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
										<img src={option.art} alt="" />
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
								Read it — change a word if you like, it is a file and not a contract.{' '}
								{photo
									? 'That photo becomes their face.'
									: `They wear the ${nature?.title.toLowerCase() ?? 'default'} art; drop a photo on the portrait to use your own.`}
							</p>
							<div className="agent-doc" style={{ width: '100%', textAlign: 'left' }}>
								<div className="agent-doc-body">
									<span className="agent-doc-fm">
										{frontmatter({
											name: name.trim(),
											gender,
											archetype,
											variant: photo ? null : archetype
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
							{state.proposal?.firstWords ? (
								<div className="agent-bubble">
									<small>{name.trim()} · first words</small>
									{state.proposal.firstWords}
								</div>
							) : null}
							<div className="agent-actions">
								{state.canGenerate ? (
									<button
										type="button"
										className="settings-small-button"
										disabled={busy || writing}
										onClick={() => draft(archetype ?? 'companion')}
									>
										{writing ? 'Writing…' : 'Write it again'}
									</button>
								) : null}
								<button
									type="button"
									className="settings-small-button"
									disabled={busy || writing}
									onClick={() => {
										// Cleared, not just stepped back: an archetype still set is what the
										// effect above reads as "already picked" and would bounce straight
										// back here with.
										setArchetype(null)
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

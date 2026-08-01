import type { Client } from '@justfiles/app'
import { injectStyle } from '@justfiles/app/browser'
import type { AccountInfo, GeneratedSoul } from '@justfiles/app/capabilities/settings'
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

type Gender = 'female' | 'male'

// ── the drafting desk ─────────────────────────────────────────────────────
// A soul being written, the answer when it comes, and why it did not. Held by the WINDOW,
// never by reducer state: that state replicates, so a draft kept there would follow the
// user to a device that never asked for one, and any "a GUI started, clean up" reset there
// would delete work in progress somewhere else. A promise has none of those problems — it
// belongs to whoever awaited it and dies with them.
//
// It lives at the GUI root, so it survives switching panes: the only lifetime a draft was
// ever meant to have.

// What was asked. `for` says which flow asked — the character sheet's Rewrite and the
// summoning must never show each other's prose — and the rest is the summoning's own
// context, enough to put the ritual back together after a pane switch unmounted it.
export interface DraftRequest {
	for: 'rewrite' | 'summoning'
	name: string
	gender: Gender
	archetype: string
}

export interface Drafting {
	// The question, while it is being answered and after: null once nothing is pending.
	request: DraftRequest | null
	// The answer, awaiting a verdict. Nothing is written until the user keeps it.
	soul: GeneratedSoul | null
	writing: boolean
	error: string | null
	// False once this host answers "no generator" (a signed-out Mac): the panes drop the
	// buttons rather than show dead ones. Per window — another device's answer is not this
	// one's, which is exactly what it used to become.
	canGenerate: boolean
	ask: (request: DraftRequest) => void
	discard: () => void
	// Clear the message alone — the banner's Dismiss, which must not throw away a draft.
	dismiss: () => void
}

const NOTHING = {
	request: null,
	soul: null,
	writing: false,
	error: null,
	canGenerate: true
} satisfies Omit<Drafting, 'ask' | 'discard' | 'dismiss'>

// A capability error's message IS its code; this is where it becomes something to read.
function why(error: unknown): { error: string; canGenerate: boolean } {
	const code = error instanceof Error ? error.message : String(error)
	// No generator here (a signed-out Mac): stop offering one, and say so once.
	if (code === 'CAPABILITY_UNAVAILABLE')
		return {
			error:
				'No AI is turned on here — write the soul yourself, or turn on a provider in Accounts.',
			canGenerate: false
		}
	// Offline is the other reason a browser cannot draft one. Unlike no-generator it is
	// TRANSIENT, so it must not hide the buttons — and writing the soul yourself works
	// offline anyway: it is a file.
	if (code === 'CAPABILITY_OFFLINE')
		return {
			error: 'No connection — write the soul yourself, or try again once you are back.',
			canGenerate: true
		}
	return { error: code, canGenerate: true }
}

export function useDrafting(client: Client<SettingsApp>, accounts: AccountInfo[]): Drafting {
	const [desk, setDesk] = useState<Omit<Drafting, 'ask' | 'discard' | 'dismiss'>>(NOTHING)
	// Only the newest question is answered. An older one finishing late has been superseded
	// by the one on screen, and its prose was written for a name the user has moved on from.
	const latest = useRef(0)

	// Turning on an AI provider brings the buttons back, with no restart and nothing to
	// re-probe: a fresh account list is the only thing that can change the answer.
	useEffect(() => {
		void accounts
		setDesk((desk) => (desk.canGenerate ? desk : { ...desk, canGenerate: true }))
	}, [accounts])

	const ask = (request: DraftRequest) => {
		const mine = ++latest.current
		setDesk((desk) => ({ ...desk, request, soul: null, error: null, writing: true }))
		const { name, gender, archetype } = request
		client
			.generateSoul({ name, gender, archetype })
			.then((soul) => {
				if (mine === latest.current) setDesk((desk) => ({ ...desk, soul, writing: false }))
			})
			.catch((error: unknown) => {
				if (mine === latest.current) setDesk((desk) => ({ ...desk, writing: false, ...why(error) }))
			})
	}
	// Also disowns one still being written: "I don't want it" means the same either way.
	const discard = () => {
		latest.current++
		setDesk((desk) => ({ ...NOTHING, canGenerate: desk.canGenerate }))
	}
	return { ...desk, ask, discard, dismiss: () => setDesk((desk) => ({ ...desk, error: null })) }
}

const CAMERA = (
	<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
		<title>Choose a photo</title>
		<path d="M9 3h6l1 2h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3l1-2Zm3 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z" />
	</svg>
)

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
	client,
	drafting
}: {
	state: SettingsState
	client: Client<SettingsApp>
	drafting: Drafting
}) {
	// Opening the ritual is GUI-local on purpose: re-entering it destroys nothing, and the
	// write only happens at Bind — so there is no "unbind" method and no confirmation for a
	// step that has not touched the volume. It is NOT the only way to be in the ritual
	// though: a summoning's draft in state means one is under way and this pane was
	// unmounted (Accounts, and back) while the model wrote, so `resume` carries it home.
	const [resummon, setResummon] = useState(false)
	const resume = drafting.request?.for === 'summoning' ? drafting.request : null

	// `soul` is null only before the first read lands.
	if (!state.soul) return <p className="settings-muted">Loading…</p>
	if (resummon || resume || !isBound(state.soul))
		return (
			<Summoning
				state={state}
				client={client}
				drafting={drafting}
				resume={resume}
				// The soul being replaced — the ritual opens on their name and says whose soul
				// this ends. Null while unbound: there is no one to replace yet.
				from={isBound(state.soul) ? state.soul : null}
				// Bind wrote them to the volume, so the ritual is over: leave it, or this pane
				// would keep showing the review step of an agent who now has a character sheet.
				onBound={() => {
					// The draft has been spent: clear the desk, or `resume` would read it as a
					// ritual still under way and walk straight back into the review step.
					drafting.discard()
					setResummon(false)
				}}
				// Backing out is only offered when there is someone to back out TO, and it drops
				// the draft — otherwise `resume` would walk straight back in.
				onCancel={
					isBound(state.soul)
						? () => {
								drafting.discard()
								setResummon(false)
							}
						: undefined
				}
			/>
		)
	return (
		<CharacterSheet
			state={state}
			soul={state.soul}
			client={client}
			drafting={drafting}
			onResummon={() => setResummon(true)}
		/>
	)
}

function CharacterSheet({
	state,
	soul,
	client,
	drafting,
	onResummon
}: {
	state: SettingsState
	// Proved non-null by `AgentPane`, and passed rather than re-derived so every hook
	// below runs unconditionally.
	soul: NonNullable<SettingsState['soul']>
	client: Client<SettingsApp>
	drafting: Drafting
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
	const writing = drafting.writing

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
		drafting.ask({
			for: 'rewrite',
			name,
			gender,
			// A rewrite reuses the recorded seed — the pane offers no way to change it.
			archetype: soul.archetype ?? 'companion'
		})

	// ONLY a rewrite is this pane's to show. A summoning's draft never reaches here — the
	// pane routes to the ritual on exactly that — and if it ever did, "Use this" would save
	// prose written for someone else under the current name and nature.
	const proposal = drafting.request?.for === 'rewrite' ? drafting.soul : null

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
						{drafting.canGenerate ? (
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
							disabled={busy || writing}
							onClick={() => {
								if (!editing) return setEditing(true)
								setEditing(false)
								if (body.trim() && body !== soul.body) void save({ body })
							}}
						>
							{editing ? 'Done' : 'Edit'}
						</button>
						{drafting.canGenerate ? (
							<button
								type="button"
								className="settings-small-button"
								disabled={busy || writing || editing}
								onClick={rewrite}
							>
								{writing ? 'Writing…' : 'Rewrite'}
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
						{writing ? (
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
							<button type="button" className="settings-small-button" onClick={drafting.discard}>
								Discard
							</button>
							<button
								type="button"
								data-primary
								disabled={busy}
								onClick={() => {
									// Kept: it is on the volume now, so the desk has nothing left to hold.
									void save({ body: proposal.body }).then(drafting.discard)
								}}
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
	drafting,
	from,
	resume,
	onBound,
	onCancel
}: {
	state: SettingsState
	client: Client<SettingsApp>
	drafting: Drafting
	// The soul being replaced, when this is "summon again": the ritual starts from the name
	// they already have rather than from nothing.
	from: SettingsState['soul']
	// A summoning already under way, as the draft in state recorded it. This is how the
	// ritual comes back after the pane was unmounted mid-question: the answer is on its way
	// (or already here) and the question came with it, so nothing has to be asked twice.
	// Only the photo cannot be restored — it is bytes, and bytes never enter state.
	resume: DraftRequest | null
	// Bind has written them: the ritual is over and the pane must move on.
	onBound: () => void
	onCancel?: () => void
}) {
	// Resumed, the ritual reopens on the nature step — where it was when it asked — and the
	// draft's arrival moves it to review, exactly as it would have.
	const [step, setStep] = useState<'name' | 'nature' | 'review'>(resume ? 'nature' : 'name')
	const [name, setName] = useState(resume?.name ?? from?.name ?? '')
	const [gender, setGender] = useState<Gender>(resume?.gender ?? from?.gender ?? 'female')
	const [archetype, setArchetype] = useState<string | null>(resume?.archetype ?? null)
	const [photo, setPhoto] = useState<{ bytes: Uint8Array<ArrayBuffer>; url: string } | null>(null)
	const [body, setBody] = useState('')
	const [busy, setBusy] = useState(false)
	const nature = archetypeOf(archetype)
	const writing = drafting.writing

	// The draft arrives on the window's desk (it cost a model call, so it survives a pane
	// switch): showing it IS the review step. Only a summoning's, though — the desk is
	// shared with the character sheet's Rewrite, and prose for the agent being REPLACED
	// would skip the name and the nature and then bind under the old archetype.
	const arrived = drafting.request?.for === 'summoning' ? drafting.soul : null
	useEffect(() => {
		if (arrived) {
			setBody(arrived.body)
			setStep('review')
		}
	}, [arrived])

	// A draft that is not coming must never strand the ritual on the picker, where the only
	// affordance is to ask again. Two ways that happens: no generator at all (a signed-out
	// Mac — known up front, or only once a call comes back CAPABILITY_UNAVAILABLE), and a
	// call that simply failed (offline, an upstream 500). Either way the nature is picked
	// and the soul is a file you can write yourself, so go where the editor is — the review
	// step also carries "Write it again", so nothing is lost by arriving early.
	// (A picked nature means a draft was asked for, and asking clears the desk's error — so
	// an error standing with nothing in flight is that attempt's.)
	useEffect(() => {
		if (!archetype) return
		if (!drafting.canGenerate || (drafting.error && !writing)) setStep('review')
	}, [archetype, drafting.canGenerate, drafting.error, writing])

	// `for: 'summoning'` is what makes the answer ours to show; the desk drops an older
	// answer that arrives after it, and everything about the call dies with this window.
	const draft = (seed: string) => {
		drafting.ask({ for: 'summoning', name: name.trim(), gender, archetype: seed })
	}

	const pickNature = (id: string) => {
		setArchetype(id)
		if (drafting.canGenerate) draft(id)
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
		// Only once the volume has them, so a failed write leaves the ritual — and the draft
		// the user is looking at — exactly where it was.
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

	const art = photo?.url ?? nature?.art ?? SPIRIT_ART

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
							{arrived?.firstWords ? (
								<div className="agent-bubble">
									<small>{name.trim()} · first words</small>
									{arrived.firstWords}
								</div>
							) : null}
							<div className="agent-actions">
								{drafting.canGenerate ? (
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

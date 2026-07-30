import { useAuth } from '@clerk/clerk-react'
import { PencilSimpleIcon, PlusIcon } from '@phosphor-icons/react'
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react'
import { builtinFaces } from '../agent/builtin'
import type { Volume } from '../fs'
import { RitualCircle } from './RitualCircle'
import { squarePng } from './squarePng'
import { type IdentityFile, PATHS, readAvatar } from './state'

const encoder = new TextEncoder()

type Archetype = 'teacher' | 'companion' | 'assistant'
type Face = 'spirit' | 'archetype' | 'upload'

type ArchetypeInfo = {
	id: Archetype
	title: string
	tagline: string
	image: string
	disposition: [number, number, number]
}

// Each card shows the art the choice actually lands on: the mascot wearing that archetype's
// accessory, from the built-in sets (src/agent/builtin.ts). What you pick is what you get.
const ARCHETYPES: ArchetypeInfo[] = [
	{
		id: 'teacher',
		title: 'Teacher',
		tagline: 'Leads you to your own answers.',
		image: builtinFaces('teacher').url,
		disposition: [4, 2, 2]
	},
	{
		id: 'companion',
		title: 'Companion',
		tagline: 'Beside you, not above you.',
		image: builtinFaces('companion').url,
		disposition: [4, 2, 3]
	},
	{
		id: 'assistant',
		title: 'Assistant',
		tagline: 'Gets things done.',
		image: builtinFaces('assistant').url,
		disposition: [2, 5, 5]
	}
]

const FORMS = [
	{ value: 'female', label: 'She' },
	{ value: 'male', label: 'He' },
	{ value: 'none', label: 'None' }
] as const

type Draft = {
	name: string
	gender: string
	archetype: Archetype
}

type UserCtx = { userAge?: number; userGender?: string }

function isArchetype(value?: string): value is Archetype {
	return ARCHETYPES.some((archetype) => archetype.id === value)
}

function initialDraft(soul: IdentityFile | null): Draft {
	const archetype = soul?.frontmatter.archetype
	return {
		name: soul?.frontmatter.agent_name ?? '',
		gender: soul?.frontmatter.agent_gender ?? 'none',
		archetype: isArchetype(archetype) ? archetype : 'companion'
	}
}

function safeLine(value: string): string {
	return value.trim().replace(/[\r\n]+/g, ' ')
}

function buildSoulFile(draft: Draft, body: string, variant?: string): string {
	const lines = ['---', 'schema: frieren/agent-soul/v1', `agent_name: ${safeLine(draft.name)}`]
	if (draft.gender !== 'none') lines.push(`agent_gender: ${draft.gender}`)
	lines.push(`archetype: ${draft.archetype}`)
	// Which built-in face set to wear. Absent means "the photo on the volume" — and, for every
	// soul written before this existed, the default set.
	if (variant) lines.push(`avatar_variant: ${variant}`)
	lines.push('---', '', body.trim(), '')
	return lines.join('\n')
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result))
		reader.onerror = () => reject(reader.error)
		reader.readAsDataURL(blob)
	})
}

const PIPS = ['one', 'two', 'three', 'four', 'five'] as const

function Disposition({ values }: { values: [number, number, number] }) {
	return (
		<dl className="frn-disposition">
			{['Warmth', 'Initiative', 'Directness'].map((label, row) => (
				<div key={label}>
					<dt>{label}</dt>
					<dd title={`${values[row]} of 5`}>
						{PIPS.map((pip, index) => (
							<i key={pip} data-lit={index < (values[row] ?? 0)} />
						))}
					</dd>
				</div>
			))}
		</dl>
	)
}

export function AgentStep({
	volume,
	userCtx,
	initialSoul,
	onBack,
	onDone
}: {
	volume: Volume
	userCtx: UserCtx
	initialSoul: IdentityFile | null
	onBack: () => void
	onDone: () => void
}) {
	const { getToken } = useAuth()
	const [draft, setDraft] = useState(() => initialDraft(initialSoul))
	const [stage, setStage] = useState<'summoning' | 'binding'>(initialSoul ? 'binding' : 'summoning')
	const [soulText, setSoulText] = useState(initialSoul?.body ?? '')
	const [firstWords, setFirstWords] = useState('“I’m here. What should we start with?”')
	const [generating, setGenerating] = useState(false)
	const [saving, setSaving] = useState(false)
	const [editing, setEditing] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [face, setFace] = useState<Face>('archetype')
	const [uploadedFace, setUploadedFace] = useState<string | null>(null)
	const uploadRef = useRef<HTMLInputElement>(null)
	const selectedArchetype = ARCHETYPES.find((item) => item.id === draft.archetype) ?? ARCHETYPES[1]
	const faceUrl =
		face === 'spirit'
			? builtinFaces(undefined).url
			: face === 'upload' && uploadedFace
				? uploadedFace
				: selectedArchetype.image

	useEffect(() => {
		if (!initialSoul) return
		// Restore what was chosen last time: an uploaded photo is on the volume, a built-in
		// variant is the word the soul recorded.
		if (initialSoul.frontmatter.avatar_variant === 'vanilla') setFace('spirit')
		void (async () => {
			const avatar = await readAvatar(volume)
			if (!avatar) return
			setUploadedFace(avatar.url)
			setFace('upload')
		})().catch(() => {})
	}, [initialSoul, volume])

	const generate = async () => {
		if (!draft.name.trim()) {
			setError('Give them a name first.')
			return
		}
		setGenerating(true)
		setError(null)
		try {
			const token = await getToken()
			const response = await fetch('/api/agent/soul', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${token ?? ''}`
				},
				body: JSON.stringify({
					agentName: draft.name.trim(),
					agentGender: draft.gender === 'none' ? undefined : draft.gender,
					archetype: draft.archetype,
					userAge: userCtx.userAge,
					userGender: userCtx.userGender
				})
			})
			if (!response.ok) throw new Error(`Summoning failed: ${response.status}`)
			const data = (await response.json()) as { text: string; firstWords?: string }
			setSoulText(data.text)
			if (data.firstWords) setFirstWords(data.firstWords)
			setStage('binding')
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			setGenerating(false)
		}
	}

	const upload = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0]
		if (!file) return
		setError(null)
		try {
			const source = URL.createObjectURL(file)
			const png = await squarePng(source)
			URL.revokeObjectURL(source)
			setUploadedFace(await blobToDataUrl(new Blob([png as BlobPart], { type: 'image/png' })))
			setFace('upload')
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		}
	}

	const bind = async () => {
		if (!soulText.trim()) {
			setError('The soul is empty — write something before you bind it.')
			return
		}
		setSaving(true)
		setError(null)
		try {
			// A built-in face is a CHOICE, so it goes in the soul as a word and the volume carries no
			// image at all: no bytes to replicate to every device, and nothing for the image engine
			// to re-derive art we already ship. Only a photo the user supplied is stored.
			const variant =
				face === 'upload' ? undefined : face === 'spirit' ? 'vanilla' : draft.archetype
			await volume.writeFile(PATHS.soul, encoder.encode(buildSoulFile(draft, soulText, variant)))
			if (face === 'upload' && uploadedFace) {
				await volume.writeFile(PATHS.avatar, await squarePng(uploadedFace))
			} else {
				// Switching back to a built-in face has to clear the photo, or the stale bytes keep
				// winning: `readAvatar` is what decides which of the two the shell shows.
				await volume.rm(PATHS.avatar, { force: true })
			}
			onDone()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
			setSaving(false)
		}
	}

	if (stage === 'binding') {
		// The frontmatter that binding will actually write, shown dimmed above the
		// prose so the document on screen is the document on disk.
		const frontmatter = buildSoulFile(draft, '').trimEnd()
		return (
			<div className="frn-binding">
				<div className="frn-binding-body">
					<section className="frn-soul-doc frn-sunken">
						<header className="frn-soul-doc-head">
							<span>{PATHS.soul}</span>
							<button type="button" onClick={() => setEditing(!editing)}>
								<PencilSimpleIcon /> {editing ? 'Done' : 'Edit'}
							</button>
						</header>
						{editing ? (
							<textarea value={soulText} onChange={(event) => setSoulText(event.target.value)} />
						) : (
							<pre className="frn-soul-text">
								<span className="frn-soul-fm">{frontmatter}</span>
								{`\n\n${soulText}`}
							</pre>
						)}
					</section>

					<aside className="frn-binding-side">
						<section className="frn-face-panel frn-raised">
							<span className="frn-sheet-label">The Face</span>
							<div className="frn-faces">
								<button
									type="button"
									className="frn-portrait frn-sunken"
									data-selected={face === 'spirit'}
									onClick={() => setFace('spirit')}
								>
									<img src={builtinFaces(undefined).url} alt="The spirit" />
								</button>
								<button
									type="button"
									className="frn-portrait frn-sunken"
									data-selected={face === 'archetype'}
									onClick={() => setFace('archetype')}
								>
									<img src={selectedArchetype.image} alt={`${selectedArchetype.title} portrait`} />
								</button>
								<button
									type="button"
									className="frn-portrait frn-sunken"
									data-selected={face === 'upload'}
									onClick={() => uploadRef.current?.click()}
								>
									{uploadedFace ? <img src={uploadedFace} alt="Uploaded portrait" /> : <PlusIcon />}
								</button>
								<input
									ref={uploadRef}
									type="file"
									accept="image/*"
									hidden
									onChange={(event) => void upload(event)}
								/>
							</div>
							<p className="frn-face-hint">
								The face they wear in your chat — the spirit, their portrait, or any image of yours.
							</p>
						</section>

						<section className="frn-dialogue frn-raised">
							<span className="frn-portrait frn-sunken">
								<img src={faceUrl} alt="" data-pixel={face === 'spirit'} />
							</span>
							<div>
								<small>{draft.name.trim()} · First words</small>
								<p>
									{firstWords}
									<i className="frn-caret">▼</i>
								</p>
							</div>
						</section>
					</aside>
				</div>
				<div className="frn-sheet-actions">
					<button type="button" onClick={() => setStage('summoning')} disabled={saving}>
						Change form
					</button>
					<button type="button" onClick={() => void generate()} disabled={generating || saving}>
						{generating ? 'Rewriting…' : 'Rewrite'}
					</button>
					<button
						type="button"
						className="frn-btn-primary"
						onClick={() => void bind()}
						disabled={saving}
					>
						{saving ? 'Binding…' : 'Bind the soul'}
					</button>
				</div>
				<footer className="frn-sheet-status" data-error={error !== null}>
					<span>{error ?? 'Binding writes soul.md — the whisper falls silent.'}</span>
				</footer>
			</div>
		)
	}

	return (
		<form
			className="frn-summon"
			onSubmit={(event: FormEvent) => {
				event.preventDefault()
				void generate()
			}}
		>
			<div className="frn-summon-body">
				<section className="frn-plaque frn-raised">
					<div className="frn-portrait frn-plaque-portrait frn-sunken">
						<img src={selectedArchetype.image} alt="" />
						{generating ? <RitualCircle fast /> : null}
					</div>
					<div className="frn-plaque-name">
						<strong>{draft.name.trim() || 'Nameless'}</strong>
						<span>{selectedArchetype.title}</span>
					</div>
					<Disposition values={selectedArchetype.disposition} />
				</section>
				<div className="frn-summon-fields">
					<label className="frn-field">
						<span className="frn-sheet-label">Name</span>
						<input
							type="text"
							placeholder="What will you call them?"
							value={draft.name}
							onChange={(event) => setDraft({ ...draft, name: event.target.value })}
							required
						/>
					</label>
					<fieldset className="frn-nature">
						<legend className="frn-sheet-label">Nature</legend>
						<div className="frn-nature-tiles">
							{ARCHETYPES.map((archetype) => (
								<button
									key={archetype.id}
									type="button"
									className="frn-tile frn-sunken"
									data-selected={draft.archetype === archetype.id}
									onClick={() => setDraft({ ...draft, archetype: archetype.id })}
								>
									<img src={archetype.image} alt="" />
									<strong>{archetype.title}</strong>
									<span className="frn-tile-tagline">{archetype.tagline}</span>
								</button>
							))}
						</div>
					</fieldset>
					<fieldset className="frn-form-picker">
						<legend className="frn-sheet-label">Form</legend>
						<div className="frn-seg">
							{FORMS.map((form) => (
								<button
									key={form.value}
									type="button"
									data-selected={draft.gender === form.value}
									onClick={() => setDraft({ ...draft, gender: form.value })}
								>
									{form.label}
								</button>
							))}
						</div>
					</fieldset>
				</div>
			</div>
			<div className="frn-sheet-actions">
				<button type="button" onClick={onBack} disabled={generating}>
					Back
				</button>
				<button type="submit" className="frn-btn-primary" disabled={generating}>
					{generating ? 'Summoning…' : 'Begin the summoning'}
				</button>
			</div>
			<footer className="frn-sheet-status" data-error={error !== null}>
				<span>{error ?? 'The soul is written before your eyes — nothing is saved yet.'}</span>
			</footer>
		</form>
	)
}

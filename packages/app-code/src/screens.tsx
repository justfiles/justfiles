import type { Client } from '@justfiles/app'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { CodeApp } from './app'
import { LinkButton, PrimaryButton, ScreenWrap, TextField } from './controls'
import { messageOf, type Project } from './gui-util'
import { type ProjectMeta, slugifyName } from './projects'

export function GalleryScreen(props: {
	projects: Project[]
	onNew: () => void
	onOpen: (slug: string) => void
}) {
	const counts = useMemo(() => {
		const next = new Map<string, number>()
		for (const project of props.projects) next.set(project.name, (next.get(project.name) ?? 0) + 1)
		return next
	}, [props.projects])

	return (
		<ScreenWrap>
			<div className="app-code-gallery-head">
				<div className="app-code-gallery-title">Projects</div>
				<PrimaryButton label="+ New Project" onClick={props.onNew} />
			</div>
			{props.projects.length === 0 ? (
				<div className="app-code-empty-state">
					<div className="app-code-empty-title">No projects yet</div>
					<div className="app-code-empty-copy">Create your first app to get started.</div>
					<div className="app-code-empty-copy">
						Apps build against the platform SDK only — external npm packages aren't supported.
					</div>
					<PrimaryButton label="+ New Project" onClick={props.onNew} />
				</div>
			) : (
				<div className="app-code-project-list">
					{props.projects.map((project, index) => (
						<ProjectRow
							key={project.slug}
							project={project}
							duplicate={(counts.get(project.name) ?? 0) > 1}
							first={index === 0}
							onOpen={props.onOpen}
						/>
					))}
				</div>
			)}
		</ScreenWrap>
	)
}

function ProjectRow(props: {
	project: Project
	duplicate: boolean
	first: boolean
	onOpen: (slug: string) => void
}) {
	return (
		<button
			type="button"
			onClick={() => props.onOpen(props.project.slug)}
			className="app-code-project-row"
			data-first={props.first ? 'true' : undefined}
		>
			<div className="app-code-project-text">
				<div className="app-code-project-name">{props.project.name}</div>
				{props.duplicate ? <div className="app-code-project-slug">{props.project.slug}</div> : null}
			</div>
			<div className="app-code-project-chevron">›</div>
		</button>
	)
}

export function NewProjectScreen(props: {
	client: Client<CodeApp>
	org: () => string
	rememberOrg: (id: string) => void
	onCancel: () => void
	onCreated: (slug: string) => Promise<void>
}) {
	const nameRef = useRef<HTMLInputElement>(null)
	const [name, setName] = useState('')
	const [id, setId] = useState(() => `${props.org()}.app`)
	const [idEdited, setIdEdited] = useState(false)
	const [error, setError] = useState('')
	const [creating, setCreating] = useState(false)
	useEffect(() => nameRef.current?.focus(), [])

	const submit = async (event: FormEvent) => {
		event.preventDefault()
		const projectName = name.trim()
		const projectId = id.trim()
		setError('')
		if (!projectName) {
			setError('Name is required.')
			return
		}
		setCreating(true)
		try {
			const created = await props.client.create({
				name: projectName,
				id: projectId
			})
			props.rememberOrg(projectId)
			await props.onCreated(created.slug)
		} catch (err) {
			setCreating(false)
			setError(messageOf(err))
		}
	}

	return (
		<ScreenWrap>
			<form onSubmit={submit}>
				<div className="app-code-gallery-head">
					<LinkButton label="‹ Cancel" onClick={props.onCancel} />
					<div className="app-code-form-title">New Project</div>
					<PrimaryButton label="Create" type="submit" disabled={creating} />
				</div>
				<TextField
					label="Name"
					value={name}
					inputRef={nameRef}
					onChange={(value) => {
						setName(value)
						if (!idEdited) setId(`${props.org()}.${slugifyName(value)}`)
					}}
				/>
				<TextField
					label="Bundle Identifier"
					value={id}
					onChange={(value) => {
						setIdEdited(true)
						setId(value)
					}}
				>
					<div className="app-code-hint">
						Use your GitHub user or organization: &lt;github-login&gt;.&lt;app&gt;
					</div>
				</TextField>
				<div className="app-code-hint">
					Apps build against the platform SDK only — external npm packages aren't supported.
				</div>
				<div className="app-code-form-error">{error}</div>
			</form>
		</ScreenWrap>
	)
}

export function SettingsScreen(props: {
	client: Client<CodeApp>
	slug: string
	meta: ProjectMeta
	onClose: () => void
	onExport: () => Promise<void>
	onDelete: () => void
}) {
	const [name, setName] = useState(props.meta.name)
	const [version, setVersion] = useState(props.meta.version ?? '')
	const [description, setDescription] = useState(props.meta.description ?? '')
	const [error, setError] = useState('')
	const [saving, setSaving] = useState(false)
	const [exporting, setExporting] = useState(false)
	const [confirming, setConfirming] = useState(false)

	const submit = async (event: FormEvent) => {
		event.preventDefault()
		const projectName = name.trim()
		setError('')
		if (!projectName) {
			setError('Name is required.')
			return
		}
		setSaving(true)
		try {
			await props.client.saveMeta({
				name: projectName,
				version: version.trim() || undefined,
				description: description.trim() || undefined
			})
			props.onClose()
		} catch (err) {
			setSaving(false)
			setError(messageOf(err))
		}
	}

	const exportZip = async () => {
		if (exporting) return
		setExporting(true)
		setError('')
		try {
			await props.onExport()
		} catch (err) {
			setError(messageOf(err))
		} finally {
			setExporting(false)
		}
	}

	return (
		<ScreenWrap>
			<form onSubmit={submit}>
				<div className="app-code-gallery-head">
					<LinkButton label="‹ Cancel" onClick={props.onClose} />
					<div className="app-code-form-title">Project Settings</div>
					<PrimaryButton label="Save" type="submit" disabled={saving} />
				</div>
				<TextField label="Name" value={name} onChange={setName} />
				<TextField label="Bundle Identifier (fixed)" value={props.slug} readOnly>
					<div className="app-code-hint">Set once at creation · the folder is the id.</div>
				</TextField>
				<TextField label="Version (optional)" value={version} onChange={setVersion} />
				<label className="app-code-field">
					<span className="app-code-field-label">Description (optional)</span>
					<textarea
						value={description}
						onChange={(event) => setDescription(event.currentTarget.value)}
						rows={3}
						className="app-code-textarea"
					/>
				</label>
				<div className="app-code-form-error">{error}</div>
			</form>
			<div className="app-code-settings-divider" />
			<div className="app-code-settings-actions">
				<button
					type="button"
					className="app-code-ghost-button"
					disabled={exporting}
					onClick={() => void exportZip()}
				>
					{exporting ? 'Exporting…' : 'Export as .zip'}
				</button>
				{confirming ? (
					<div className="app-code-confirm-row">
						<span className="app-code-confirm-text">Delete this project?</span>
						<LinkButton label="Cancel" onClick={() => setConfirming(false)} />
						<button type="button" className="app-code-danger-button" onClick={props.onDelete}>
							Delete
						</button>
					</div>
				) : (
					<button
						type="button"
						className="app-code-danger-button"
						onClick={() => setConfirming(true)}
					>
						Delete Project
					</button>
				)}
			</div>
		</ScreenWrap>
	)
}

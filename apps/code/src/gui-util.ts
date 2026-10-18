import { type CodeState, type CodeStatus, initialState, isCodeState } from './app'

export type Project = { slug: string; name: string }

// The source-file read state for the editor pane: the path being shown, its text
// once loaded, and any read error. Owned by the editor controller, handed to the
// editor screen.
export type SourceView = {
	path: string | null
	content: string | null
	error: string | null
}

export const stateOrInitial = (value: unknown): CodeState =>
	isCodeState(value) ? value : initialState

export const STATUS: Record<CodeStatus, { label: string; className: string }> = {
	idle: { label: 'Idle', className: 'is-idle' },
	updating: { label: 'Updating', className: 'is-updating' },
	building: { label: 'Building', className: 'is-building' },
	live: { label: 'Live', className: 'is-live' },
	'needs-fixes': { label: 'Needs fixes', className: 'is-needs-fixes' },
	crashed: { label: 'Crashed', className: 'is-crashed' }
}

export const ICON_PLACEHOLDER =
	'data:image/svg+xml,' +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
			`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
			`<stop offset="0" stop-color="#ececef"/><stop offset="1" stop-color="#d4d4d9"/>` +
			`</linearGradient></defs><rect width="64" height="64" fill="url(#g)"/>` +
			`<g fill="none" stroke="#b3b3ba" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">` +
			`<rect x="18" y="18" width="28" height="28" rx="7"/><path d="M23 41l7-8 4 4 5-6 6 10"/></g>` +
			`<circle cx="27" cy="27" r="2.5" fill="#b3b3ba"/></svg>`
	)

export function fallbackText(
	state: CodeState,
	source: SourceView
): { text: string; error: boolean } {
	if (state.files.length === 0) return { text: 'Empty project.', error: false }
	if (!state.selectedPath) return { text: 'Select a file to edit.', error: false }
	if (source.error) return { text: source.error, error: true }
	return { text: 'Loading…', error: false }
}

export function createWriter(write: (path: string, content: string) => Promise<void>, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined
	let pending: { path: string; content: string } | null = null
	let inflight: Promise<void> = Promise.resolve()
	const fire = () => {
		if (timer) {
			clearTimeout(timer)
			timer = undefined
		}
		if (!pending) return
		const { path, content } = pending
		pending = null
		inflight = write(path, content)
	}
	return {
		push(path: string, content: string) {
			if (pending && pending.path !== path) fire()
			pending = { path, content }
			if (timer) clearTimeout(timer)
			timer = setTimeout(fire, ms)
		},
		flush: fire,
		async drain() {
			fire()
			await inflight.catch(() => {})
		}
	}
}

export function downloadZip(name: string, zip: Uint8Array) {
	const buffer = new ArrayBuffer(zip.byteLength)
	new Uint8Array(buffer).set(zip)
	const url = URL.createObjectURL(new Blob([buffer], { type: 'application/zip' }))
	const anchor = document.createElement('a')
	anchor.href = url
	anchor.download = name
	anchor.click()
	setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function messageOf(err: unknown) {
	return err instanceof Error ? err.message : String(err)
}

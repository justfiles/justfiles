import { AVATAR_PATH, avatarFaceHash, avatarFacePath, SOUL_PATH } from '@justfiles/agent/defaults'
import { EXPRESSIONS, type Expression } from '@justfiles/agent/expression'
import type { Volume } from '../fs'

// How the SHELL reads the agent's identity off the volume: the name to greet by, the face
// to wear, and the per-expression faces derived from it. Read-only on purpose — writing
// these files is Settings' Agent pane (the `settings` capability's `agent.*` methods), so
// there is one writer and this side only ever reacts to the files changing.
export const PATHS = {
	soul: SOUL_PATH,
	avatar: AVATAR_PATH
} as const

export type IdentityFile = {
	frontmatter: Record<string, string>
	body: string
}

const decoder = new TextDecoder()

export function parseIdentityFile(text: string): IdentityFile {
	const match = text.match(/^---\n([\s\S]*?)\n---(?:\n+([\s\S]*))?$/)
	if (!match) return { frontmatter: {}, body: text.trim() }
	const frontmatter: Record<string, string> = {}
	for (const line of match[1].split('\n')) {
		const idx = line.indexOf(':')
		if (idx === -1) continue
		const key = line.slice(0, idx).trim()
		const value = line.slice(idx + 1).trim()
		if (key) frontmatter[key] = value
	}
	return { frontmatter, body: (match[2] ?? '').trim() }
}

async function readIdentityFile(volume: Volume, path: string): Promise<IdentityFile | null> {
	if (!(await volume.exists(path))) return null
	return parseIdentityFile(decoder.decode(await volume.readFile(path)))
}

export async function readAgentSoul(volume: Volume): Promise<IdentityFile | null> {
	return readIdentityFile(volume, PATHS.soul)
}

/**
 * The chosen face: its data URL plus the content hash that names its per-expression
 * variants. Null while still on the bundled default.
 */
export async function readAvatar(volume: Volume): Promise<{ url: string; hash: string } | null> {
	if (!(await volume.exists(PATHS.avatar))) return null
	const bytes = await volume.readFile(PATHS.avatar)
	return { url: await pngDataUrl(bytes), hash: await avatarFaceHash(bytes) }
}

/**
 * Per-expression faces derived from THIS avatar (the hash is in each file name, so a
 * replaced avatar simply has none until they are regenerated — see src/agent/faces.ts).
 */
export async function readAvatarFaces(
	volume: Volume,
	hash: string
): Promise<Partial<Record<Expression, string>>> {
	const faces: Partial<Record<Expression, string>> = {}
	for (const expression of EXPRESSIONS) {
		const path = avatarFacePath(expression, hash)
		if (!(await volume.exists(path))) continue
		faces[expression] = await pngDataUrl(await volume.readFile(path)).catch(() => undefined)
	}
	return faces
}

function pngDataUrl(bytes: Uint8Array): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result))
		reader.onerror = () => reject(reader.error)
		reader.readAsDataURL(new Blob([bytes as BlobPart], { type: 'image/png' }))
	})
}

/**
 * Call `onChange` whenever the agent's identity changes on the volume: the soul (a rename,
 * a rewritten prose) or the face. The shell has no other way to hear about it — the writes
 * happen in Settings' app frame, and a soul edited on ANOTHER DEVICE arrives as sync, which
 * nothing could have told us about before this existed.
 */
export async function watchIdentity(volume: Volume, onChange: () => void): Promise<() => void> {
	const stops = await Promise.all(
		[PATHS.soul, PATHS.avatar].map((path) => volume.watch(path, () => onChange()))
	)
	return () => {
		for (const stop of stops) stop()
	}
}

import { BUILTIN_AVATARS, builtinFaces } from '@justfiles/agent/avatars'
import {
	AVATARS_DIR,
	avatarDir,
	avatarFaceHash,
	avatarMime,
	avatarState,
	SOUL_PATH
} from '@justfiles/agent/defaults'
import { EXPRESSIONS, type Expression } from '@justfiles/agent/expression'
import type { Volume } from '../fs'

// How the SHELL reads the agent's identity off the volume: the name to greet by, and the
// avatar it is wearing. Read-only on purpose — writing these files is Settings' Agent pane
// (the `settings` capability's `agent.*` methods), so there is one writer and this side only
// ever reacts to the files changing.
export const PATHS = {
	soul: SOUL_PATH,
	avatars: AVATARS_DIR
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

/** The art derived from ONE resting file, by the image model. Written by ./faces.ts. */
export const derivedRoot = (ref: string) => `${avatarDir(ref)}/.gen`
export const derivedDir = (ref: string, hash: string) => `${derivedRoot(ref)}/${hash}`

// `avatar:` in the soul names a SOURCE, not a file: `builtin/<id>` is art in the app bundle
// (so choosing it costs no bytes, syncs nothing, and updates when the app does), and anything
// else is an id on the volume — the user's photo, or a pack they installed.
const BUILTIN = 'builtin/'
const DEFAULT_BUILTIN = 'vanilla'

export type Avatar = {
	url: string
	// The resting file's content hash, and null for a built-in — whose bytes are not on the
	// volume and cannot be replaced, so there is nothing to derive art FROM. That null is the
	// whole reason no code has to say "never generate for a built-in".
	hash: string | null
	faces: Partial<Record<Expression, string>>
}

/**
 * The avatar a soul names: the face it rests on, plus a face per expression to swap to.
 *
 * One chain, per expression E: `<avatar>/E.*` (authored — by the user or by a pack), then
 * `<avatar>/.gen/<hash>/E.*` (derived from exactly THIS resting file), then nothing — and the
 * caller asks for E to be generated. An avatar that is not here (a deleted pack, a soul
 * synced from a device that has one this one does not) falls back to the built-in default,
 * which is also what an absent ref means.
 */
export async function readAvatar(volume: Volume, ref: string | undefined): Promise<Avatar> {
	if (ref && !ref.startsWith(BUILTIN)) {
		const worn = await fromVolume(volume, ref)
		if (worn) return worn
	}
	return builtin(ref?.startsWith(BUILTIN) ? ref.slice(BUILTIN.length) : undefined)
}

async function builtin(id: string | undefined): Promise<Avatar> {
	const worn = id && BUILTIN_AVATARS[id] ? id : DEFAULT_BUILTIN
	const art = BUILTIN_AVATARS[worn]
	if (!art) throw new Error('no built-in avatars — run `pnpm run avatars` in apps/frieren')
	// The expressions are a dynamic import: the shell needs the WORN set, and only once a
	// feeling is tagged, so the other built-ins' art is never fetched at all.
	const drawn = await builtinFaces(worn)
	const faces: Partial<Record<Expression, string>> = {}
	for (const expression of EXPRESSIONS) {
		const url = drawn[expression]
		if (url) faces[expression] = url
	}
	return { url: art.resting, hash: null, faces }
}

/**
 * What the shell paints before the first read lands: the default built-in, resting. It is in
 * the app bundle, so there is nothing to wait for and no hole where a face goes — the faces
 * follow with the first `readAvatar`, a tick later.
 */
export const DEFAULT_AVATAR: Avatar = {
	url: BUILTIN_AVATARS[DEFAULT_BUILTIN]?.resting ?? '',
	hash: null,
	faces: {}
}

// Resolution is `readdir` + match by STEM, so the reader never names an extension: what an
// avatar covers is which files exist, and `resting.webm` would resolve here unchanged.
async function fromVolume(volume: Volume, ref: string): Promise<Avatar | null> {
	const dir = avatarDir(ref)
	if (!(await volume.exists(dir))) return null
	const names = (await volume.readdir(dir)).map((entry) => entry.name)
	const resting = names.find((name) => avatarState(name) === 'resting')
	if (!resting) return null
	const bytes = await volume.readFile(`${dir}/${resting}`)
	const hash = await avatarFaceHash(bytes)

	const faces: Partial<Record<Expression, string>> = {}
	const take = async (from: string, name: string) => {
		const state = avatarState(name) as Expression
		if (faces[state] || !EXPRESSIONS.includes(state)) return
		faces[state] = dataUrl(await volume.readFile(`${from}/${name}`), name)
	}
	// Authored first: the artist's file wins as a LOOKUP ORDER, not as a rule to remember.
	for (const name of names) await take(dir, name)
	const derived = derivedDir(ref, hash)
	if (await volume.exists(derived)) {
		for (const entry of await volume.readdir(derived)) await take(derived, entry.name)
	}
	return { url: dataUrl(bytes, resting), hash, faces }
}

// A data URL rather than a blob URL: these sit in React state next to the built-in art, which
// is data URLs too, and nothing has to own a revoke. The mime comes from the extension — the
// one thing about a state's file this reader has to know.
function dataUrl(bytes: Uint8Array, name: string): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return `data:${avatarMime(name)};base64,${btoa(binary)}`
}

/**
 * Call `onChange` whenever the agent's identity changes on the volume: the soul (a rename, a
 * rewritten prose, a different avatar worn) or the avatars themselves. The shell has no other
 * way to hear about it — the writes happen in Settings' app frame, and a soul edited on
 * ANOTHER DEVICE arrives as sync, which nothing could have told us about before this existed.
 *
 * Wearing and installing are BOTH file events now, so the avatars directory is watched
 * whole: a pack landing, a face generated on another device, a photo replaced (which
 * `putAvatarFile` publishes as a fresh file, so it is structure and not a silent edit).
 */
export async function watchIdentity(volume: Volume, onChange: () => void): Promise<() => void> {
	const stops = await Promise.all([
		volume.watch(PATHS.soul, () => onChange()),
		volume.watch(PATHS.avatars, () => onChange(), { recursive: true })
	])
	return () => {
		for (const stop of stops) stop()
	}
}

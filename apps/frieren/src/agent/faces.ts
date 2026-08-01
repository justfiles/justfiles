import type { Expression } from '@justfiles/agent/expression'
import type { Volume } from '../fs'
import { derivedDir, derivedRoot, readAvatar } from './identity'
import { squareImage } from './squareImage'

// Lazy per-expression faces. The agent tags a sentence, the avatar finds no face for that
// tag, and this asks the worker to derive one from the avatar's `resting.*` with the image
// model. It returns nothing useful to the caller on purpose: the resting face stays on screen
// and the generated one shows up the NEXT time that expression occurs (generation takes ~10s).
//
// The worker returns a ~1024px image, so the bytes are downscaled to the same 256² square as
// the resting file before they reach the Volume — six 1MB files would be replicated to every
// device otherwise. The file is named for the format that came back, which is WebP wherever
// the browser can encode it (see ./squareImage.ts).

export async function requestFace(
	volume: Volume,
	getToken: () => Promise<string | null>,
	avatar: string,
	expression: Expression,
	hash: string
): Promise<boolean> {
	const token = await getToken()
	const response = await fetch('/api/agent/face', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}` },
		body: JSON.stringify({ avatar, expression, hash })
	})
	if (!response.ok) return false
	const face = (await response.json()) as { data?: string; mimeType?: string; hash?: string }
	// `skipped`: no image engine, a spent AI cap, a provider refusal, or a stale hash. All
	// unremarkable — keep the resting face.
	if (!face.data || !face.mimeType || face.hash !== hash) return false

	// GENERATION TAKES ~10s, AND THE USER CAN REPLACE THE ART INSIDE IT. The answer is about
	// `hash`, which the worker confirmed — but the avatar may rest on something else by now,
	// and the sweep below is the destructive step: it would collect the CURRENT set as stale
	// and leave art nobody can resolve in its place. So the volume gets the last word.
	if ((await readAvatar(volume, avatar)).hash !== hash) return false

	const dir = derivedDir(avatar, hash)
	// Art derived from a resting file that has since been replaced is collected HERE rather
	// than by a scheduled sweep: one directory per hash, so taking the siblings out before
	// writing leaves at most the current set. Authored files are in the avatar's own
	// directory and are never touched — that is what the `.gen` split buys.
	const root = derivedRoot(avatar)
	for (const stale of await volume.readdir(root).catch(() => [])) {
		if (stale.name !== hash) await volume.rm(`${root}/${stale.name}`, { recursive: true })
	}
	await volume.mkdir(dir, { recursive: true })
	const drawn = await squareImage(`data:${face.mimeType};base64,${face.data}`)
	await volume.writeFile(`${dir}/${expression}.${drawn.ext}`, drawn.bytes)
	return true
}

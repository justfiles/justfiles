import { avatarFacePath } from '@justfiles/agent/defaults'
import type { Expression } from '@justfiles/agent/expression'
import type { Volume } from '../fs'
import { squarePng } from '../personalize/squarePng'

// Lazy per-expression faces. The agent tags a sentence, the avatar finds no face for that
// tag, and this asks the worker to derive one from `avatar.png` with the image model. It
// returns nothing useful to the caller on purpose: the base avatar stays on screen and the
// generated face shows up the NEXT time that expression occurs (generation takes ~10s).
//
// The worker returns a ~1024px image, so the bytes are downscaled to the same 256² square
// as `avatar.png` before they reach the Volume — six 1MB files would be replicated to every
// device otherwise. That also normalises the mime (the engine sometimes answers JPEG).

export async function requestFace(
	volume: Volume,
	getToken: () => Promise<string | null>,
	expression: Expression,
	hash: string
): Promise<boolean> {
	const token = await getToken()
	const response = await fetch('/api/agent/face', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}` },
		body: JSON.stringify({ expression, hash })
	})
	if (!response.ok) return false
	const face = (await response.json()) as { data?: string; mimeType?: string; hash?: string }
	// `skipped`: no image engine, a spent AI cap, a provider refusal, or a stale hash. All
	// unremarkable — keep the base avatar.
	if (!face.data || !face.mimeType || face.hash !== hash) return false

	const png = await squarePng(`data:${face.mimeType};base64,${face.data}`)
	await volume.writeFile(avatarFacePath(expression, hash), png)
	return true
}

import { AVATAR_PATH, avatarFaceHash } from '@justfiles/agent/defaults'
import { type Expression, facePrompt } from '@justfiles/agent/expression'
import type { GeneratedImage } from '@justfiles/app/capabilities/image'
import type { Volume } from '@justfiles/fs'

// One per-expression face, derived from `avatar.png` by the image engine. Lazy by design:
// the browser asks only for the expression it just needed, keeps showing the base avatar
// meanwhile, and picks the face up on a later turn (generation takes ~10s).
//
// Never throws. A face is cosmetic, so every failure mode — no engine, no avatar, a stale
// request, a spent AI cap, a provider refusal — is just `null`, and the caller keeps the
// base avatar.

const BACKOFF_MS = 24 * 60 * 60 * 1000

export interface FaceDeps {
	volume: Volume
	// The DO's storage, narrowed to what the backoff needs.
	storage: {
		get<T>(key: string): Promise<T | undefined>
		put<T>(key: string, value: T): Promise<void>
		delete(key: string): Promise<boolean>
	}
	// The metered image engine; absent when the platform has none (local dev).
	generate?: (prompt: string, source: GeneratedImage) => Promise<GeneratedImage[]>
	// Shared across calls so a second tab (or a repeat of the same expression) joins the
	// running generation instead of paying for a second image.
	inFlight: Map<string, Promise<GeneratedImage | null>>
	now?: () => number
}

export async function generateFace(
	deps: FaceDeps,
	expression: Expression,
	hash: string
): Promise<(GeneratedImage & { hash: string }) | null> {
	const key = `${hash}:${expression}`
	// Claim the key BEFORE the first await — two tabs asking at once must not both pay.
	const running = deps.inFlight.get(key)
	const run = running ?? produce(deps, expression, hash)
	if (!running) deps.inFlight.set(key, run)
	try {
		const image = await run
		return image ? { ...image, hash } : null
	} finally {
		if (!running) deps.inFlight.delete(key)
	}
}

async function produce(
	deps: FaceDeps,
	expression: Expression,
	hash: string
): Promise<GeneratedImage | null> {
	const { volume, storage, generate } = deps
	const now = deps.now ?? Date.now
	if (!generate) return null
	if (!(await volume.exists(AVATAR_PATH))) return null

	const source = await volume.readFile(AVATAR_PATH)
	// The caller names the file after ITS avatar's hash. A mismatch means the two sides
	// disagree about the face's source (a sync in flight) — let it ask again later.
	if ((await avatarFaceHash(source)) !== hash) return null

	// A refusal (or a broken engine) must not be retried on every occurrence of the
	// expression. Derived state, so it lives in DO storage, not the profile.
	const failedKey = `face-failed/${hash}:${expression}`
	const failedAt = await storage.get<number>(failedKey)
	if (failedAt && now() - failedAt < BACKOFF_MS) return null

	try {
		const [image] = await generate(facePrompt(expression), {
			data: encodeBase64(source),
			mimeType: 'image/png'
		})
		if (!image) throw new Error('the image engine returned no image')
		await storage.delete(failedKey)
		return image
	} catch (error) {
		console.error('[agent] face generation failed:', error)
		await storage.put(failedKey, now())
		return null
	}
}

// The image engine speaks base64 (pi-ai's ImageContent); the Volume speaks bytes.
function encodeBase64(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
}

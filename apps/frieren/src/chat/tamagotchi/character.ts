// Character skin definitions + clip resolution for the tamagotchi scene.
// Runtime consumes auto-discovered skin bundles with Aseprite-style metadata.

export type Ctx = CanvasRenderingContext2D

export type CharacterActivity = 'idle' | 'walk' | 'listen' | 'talk'
export type CharacterEmotion = 'neutral' | 'happy' | 'sad' | 'angry'
export type CharacterReaction = 'none' | 'poke'

export interface CharacterPose {
	activity: CharacterActivity
	emotion: CharacterEmotion
	reaction: CharacterReaction
}

interface FrameRect {
	x: number
	y: number
	w: number
	h: number
}

interface SheetFrame {
	frame: FrameRect
	durationMs: number
}

export interface AnimationClip {
	frames: SheetFrame[]
	loop: boolean
	totalDurationMs: number
}

interface SheetTag {
	name: string
	from: number
	to: number
	direction?: string
}

interface AsepriteFrame {
	filename: string
	frame: FrameRect
	duration: number
}

export interface AsepriteData {
	frames: AsepriteFrame[] | Record<string, AsepriteFrame>
	meta: {
		image: string
		size: {
			w: number
			h: number
		}
		frameTags?: SheetTag[]
	}
}

export interface SkinBundle {
	id: string
	avatarUrl: string
	sheetUrl: string
	sheetData: AsepriteData
	displayScale?: number
}

export interface SkinDefinition {
	id: string
	size: {
		w: number
		h: number
	}
	displayScale: number
	avatarUrl: string
	imageSrc: string
	clips: Record<string, AnimationClip>
}

const ONE_SHOT_CLIPS = new Set(['poke'])
const imageCache = new Map<string, HTMLImageElement | null>()
const skinModules = import.meta.glob('./skins/*/index.ts', { eager: true }) as Record<
	string,
	{ default: SkinBundle }
>

function getImage(src: string) {
	if (!imageCache.has(src)) {
		const image = new Image()
		image.src = src
		image.decode().catch(() => {})
		imageCache.set(src, image)
	}

	return imageCache.get(src) ?? null
}

function normalizeFrames(frames: AsepriteData['frames']) {
	return Array.isArray(frames) ? frames : Object.values(frames)
}

function frameAtIndex(frames: AsepriteFrame[], index: number) {
	const frame = frames[index]
	return {
		frame: frame.frame,
		durationMs: frame.duration
	}
}

function expandTagFrames(frames: AsepriteFrame[], tag: SheetTag) {
	const indices: number[] = []

	if (tag.direction === 'reverse') {
		for (let i = tag.to; i >= tag.from; i--) indices.push(i)
	} else if (tag.direction === 'pingpong') {
		for (let i = tag.from; i <= tag.to; i++) indices.push(i)
		for (let i = tag.to - 1; i > tag.from; i--) indices.push(i)
	} else {
		for (let i = tag.from; i <= tag.to; i++) indices.push(i)
	}

	return indices.map((index) => frameAtIndex(frames, index))
}

function createClip(frames: SheetFrame[], loop: boolean): AnimationClip {
	return {
		frames,
		loop,
		totalDurationMs: Math.max(
			1,
			frames.reduce((sum, frame) => sum + frame.durationMs, 0)
		)
	}
}

function skinFromBundle(bundle: SkinBundle): SkinDefinition {
	const frames = normalizeFrames(bundle.sheetData.frames)
	const tags = bundle.sheetData.meta.frameTags ?? []
	const firstFrame = frames[0]
	const clips = Object.fromEntries(
		tags.map((tag) => {
			const clipFrames = expandTagFrames(frames, tag)
			return [tag.name, createClip(clipFrames, !ONE_SHOT_CLIPS.has(tag.name))]
		})
	)

	return {
		id: bundle.id,
		size: {
			w: firstFrame.frame.w,
			h: firstFrame.frame.h
		},
		displayScale: bundle.displayScale ?? 28 / firstFrame.frame.h,
		avatarUrl: bundle.avatarUrl,
		imageSrc: bundle.sheetUrl,
		clips
	}
}

const BUNDLES = Object.fromEntries(
	Object.values(skinModules).map((module) => [module.default.id, module.default])
)
const SKINS = Object.fromEntries(
	Object.values(BUNDLES).map((bundle) => [bundle.id, skinFromBundle(bundle)])
) as Record<string, SkinDefinition>

export const DEFAULT_SKIN_ID = 'frieren'

for (const skin of Object.values(SKINS)) getImage(skin.imageSrc)

function clipKey(activity: CharacterActivity, emotion: CharacterEmotion) {
	return `${activity}_${emotion}`
}

export function listSkinIds() {
	return Object.keys(SKINS)
}

export function getSkin(skinId: string) {
	const skin = SKINS[skinId] ?? SKINS[DEFAULT_SKIN_ID]
	if (skin) return skin
	throw new Error(`Missing skin: ${skinId}`)
}

export function getSkinAvatarUrl(skinId: string) {
	return getSkin(skinId).avatarUrl
}

export function resolveClip(skin: SkinDefinition, pose: CharacterPose) {
	if (pose.reaction !== 'none') {
		const reactionClip = skin.clips[pose.reaction]
		if (reactionClip) return reactionClip
	}

	const keys = [
		clipKey(pose.activity, pose.emotion),
		clipKey(pose.activity, 'neutral'),
		clipKey('idle', pose.emotion),
		'idle_neutral'
	]

	for (const key of keys) {
		const clip = skin.clips[key]
		if (clip) return clip
	}

	const [firstClip] = Object.values(skin.clips)
	if (firstClip) return firstClip
	throw new Error(`Skin ${skin.id} has no clips`)
}

export function frameAt(clip: AnimationClip, elapsedMs: number) {
	if (clip.frames.length <= 1) return clip.frames[0]

	let time = elapsedMs
	if (clip.loop) time %= clip.totalDurationMs
	else time = Math.min(time, clip.totalDurationMs - 1)

	for (const frame of clip.frames) {
		if (time < frame.durationMs) return frame
		time -= frame.durationMs
	}

	const lastFrame = clip.frames.at(-1)
	if (lastFrame) return lastFrame
	throw new Error('Animation clip has no frames')
}

export function drawCharacterFrame(
	ctx: Ctx,
	skin: SkinDefinition,
	frame: SheetFrame,
	x: number,
	y: number,
	scale: number,
	facing: 1 | -1
) {
	const image = getImage(skin.imageSrc)
	if (!image?.complete || image.naturalWidth === 0) return

	const dw = Math.max(1, Math.round(skin.size.w * scale * skin.displayScale))
	const dh = Math.max(1, Math.round(skin.size.h * scale * skin.displayScale))
	const dx = Math.round(x - dw / 2)
	const dy = Math.round(y - dh)

	ctx.save()
	if (facing < 0) {
		ctx.translate(dx * 2 + dw, 0)
		ctx.scale(-1, 1)
	}
	ctx.drawImage(image, frame.frame.x, frame.frame.y, frame.frame.w, frame.frame.h, dx, dy, dw, dh)
	ctx.restore()
}

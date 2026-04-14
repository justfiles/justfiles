// Scene orchestration: procgen landscape, character sim, render loop.
// Framework-agnostic — takes a canvas, returns a handle.

import { DEFAULT_SKIN_ID, drawCharacterFrame, frameAt, getSkin, resolveClip } from './character'
import type { CharacterActivity, CharacterEmotion, CharacterPose } from './character'
import { PALETTES, type Biome, type Palette } from './palettes'
import { mulberry32, makeNoise1D, type Noise1D } from './rng'
import { drawProp, type Prop, type PropKind } from './sprites'

export type SceneMode = 'roam' | 'listen' | 'talk'

export interface TamagotchiOptions {
	canvas: HTMLCanvasElement
	seed?: number
	biome?: Biome
	pixelScale?: number
	skinId?: string
}

export interface TamagotchiHandle {
	setMode(mode: SceneMode): void
	setSkin(skinId: string): void
	setEmotion(emotion: CharacterEmotion): void
	setBiome(biome: Biome): void
	poke(): void
	regenerate(seed?: number): void
	destroy(): void
}

export function createTamagotchi(opts: TamagotchiOptions): TamagotchiHandle {
	const canvas = opts.canvas
	const ctx = canvas.getContext('2d')!
	ctx.imageSmoothingEnabled = false

	let seed = opts.seed ?? Math.floor(Math.random() * 1e9)
	let biome: Biome = opts.biome ?? 'meadow'
	let mode: SceneMode = 'roam'
	const pixel = opts.pixelScale ?? 2

	let width = 0
	let height = 0
	let rand = mulberry32(seed)
	let noise: Noise1D = makeNoise1D(rand)
	let palette: Palette = PALETTES[biome]
	let farHills: number[] = []
	let midHills: number[] = []
	let nearHills: number[] = []
	let props: Prop[] = []

	const char: {
		x: number
		y: number
		tx: number
		ty: number
		facing: 1 | -1
		skinId: string
		pose: CharacterPose
		clipElapsed: number
		lastClip: string
		pokeUntil: number
	} = {
		x: 40,
		y: 0,
		tx: 40,
		ty: 0,
		facing: 1 as 1 | -1,
		skinId: opts.skinId ?? DEFAULT_SKIN_ID,
		pose: {
			activity: 'idle',
			emotion: 'neutral',
			reaction: 'none'
		},
		clipElapsed: 0,
		lastClip: 'idle_neutral',
		pokeUntil: 0
	}

	// ground plane: yFar = horizon, yNear = bottom. Scale lerps between.
	const yFar = () => height * 0.4
	const yNear = () => height - 4
	// upper end is unclamped so "close-up" positions below yNear scale beyond 1
	const depthT = (y: number) => {
		const f = yFar()
		const n = yNear()
		return Math.max(0, (y - f) / (n - f))
	}
	const scaleAt = (y: number) => 0.5 + Math.min(1, depthT(y)) * 0.7 + Math.max(0, depthT(y) - 1) * 1.1

	// walkable trapezoid narrows toward the horizon
	const boundsAt = (y: number): [number, number] => {
		const t = depthT(y)
		const margin = (1 - t) * width * 0.22
		return [margin + 8, width - margin - 8]
	}

	function rebuild() {
		rand = mulberry32(seed)
		noise = makeNoise1D(rand)
		palette = PALETTES[biome]

		const w = Math.max(1, Math.ceil(width))
		farHills = new Array(w)
		midHills = new Array(w)
		nearHills = new Array(w)
		for (let x = 0; x < w; x++) {
			farHills[x] = height * 0.2 + noise(x * 0.012 + 10, 3) * height * 0.18
			midHills[x] = height * 0.36 + noise(x * 0.02 + 40, 4) * height * 0.1
			nearHills[x] = height * 0.5 + noise(x * 0.04 + 99, 3) * height * 0.08
		}

		const pool: PropKind[] =
			biome === 'ruins'
				? ['pillar', 'rock', 'bush', 'flower', 'rock']
				: biome === 'forest'
					? ['tree', 'tree', 'bush', 'mushroom', 'rock']
					: biome === 'night'
						? ['tree', 'bush', 'mushroom', 'flower']
						: ['tree', 'bush', 'flower', 'flower', 'rock', 'mushroom']

		// poisson-lite: rejection sampling with depth-weighted distance
		props = []
		const minDist = 12
		for (let i = 0; i < 80; i++) {
			const py = yFar() + 4 + rand() * (yNear() - yFar() - 4)
			const [lo, hi] = boundsAt(py)
			const px = lo + rand() * (hi - lo)
			let ok = true
			for (const q of props) {
				const dx = q.x - px
				const dy = (q.y - py) * 2.5
				if (dx * dx + dy * dy < minDist * minDist) {
					ok = false
					break
				}
			}
			if (!ok) continue
			const kind = pool[Math.floor(rand() * pool.length)]
			props.push({ kind, x: px, y: py, variant: Math.floor(rand() * 3) })
		}

		char.y = yNear() - 2
		char.ty = char.y
		char.x = Math.min(Math.max(char.x, 12), Math.max(12, width - 12))
		char.tx = char.x
	}

	// ---------- drawing ----------

	function drawSky() {
		const g = ctx.createLinearGradient(0, 0, 0, height)
		g.addColorStop(0, palette.sky[0])
		g.addColorStop(1, palette.sky[1])
		ctx.fillStyle = g
		ctx.fillRect(0, 0, width, height)
		if (biome === 'night') {
			const r = mulberry32(seed ^ 0x9e3779b9)
			ctx.fillStyle = '#ffffff'
			for (let i = 0; i < 24; i++) {
				const x = Math.floor(r() * width)
				const y = Math.floor(r() * yFar())
				ctx.globalAlpha = 0.4 + r() * 0.6
				ctx.fillRect(x, y, 1, 1)
			}
			ctx.globalAlpha = 1
		}
	}

	function drawHillBand(data: number[], color: string, alpha: number) {
		ctx.globalAlpha = alpha
		ctx.fillStyle = color
		ctx.beginPath()
		ctx.moveTo(0, height)
		for (let x = 0; x < data.length; x++) ctx.lineTo(x, data[x])
		ctx.lineTo(width, height)
		ctx.closePath()
		ctx.fill()
		ctx.globalAlpha = 1
	}

	function drawGround() {
		ctx.fillStyle = palette.ground
		ctx.fillRect(0, yFar() + 6, width, height)
		for (let i = 0; i < 6; i++) {
			const t = i / 6
			const y = yFar() + 6 + t * (yNear() - yFar() - 2)
			ctx.fillStyle = i % 2 ? palette.groundDark : palette.ground
			ctx.globalAlpha = 0.2
			ctx.fillRect(0, y, width, 2)
		}
		ctx.globalAlpha = 1
	}

	function drawFog() {
		const g = ctx.createLinearGradient(0, yFar() - 4, 0, yFar() + 16)
		g.addColorStop(0, palette.fog)
		g.addColorStop(1, 'rgba(0,0,0,0)')
		ctx.fillStyle = g
		ctx.fillRect(0, yFar() - 4, width, 20)
	}

	function drawShadow(x: number, y: number, s: number) {
		ctx.fillStyle = palette.shadow
		ctx.beginPath()
		ctx.ellipse(x, y, 4.5 * s, 1.2 * s, 0, 0, Math.PI * 2)
		ctx.fill()
	}

	function renderProp(p: Prop) {
		const s = scaleAt(p.y) * pixel
		drawShadow(p.x, p.y, s)
		drawProp(ctx, palette, p, s)
	}

	function renderCharacter() {
		const skin = getSkin(char.skinId)
		const s = scaleAt(char.y) * pixel
		drawShadow(char.x, char.y, s)

		const clip = resolveClip(skin, char.pose)
		const frame = frameAt(clip, char.clipElapsed)
		const bob = Math.sin(char.clipElapsed * 0.008) * 0.6
		const now = performance.now()
		const drawnHeight = skin.size.h * skin.displayScale * s
		const py = Math.round(char.y - drawnHeight + bob)

		ctx.save()
		if (char.pose.reaction === 'poke') {
			const t = Math.sin((char.pokeUntil - now) * 0.03)
			const cx = char.x
			const cy = py + drawnHeight
			ctx.translate(cx, cy)
			ctx.scale(1 + t * 0.12, 1 - t * 0.12)
			ctx.translate(-cx, -cy)
		}
		drawCharacterFrame(ctx, skin, frame, char.x, char.y + bob, s, char.facing)
		ctx.restore()
	}

	function drawVignette() {
		ctx.fillStyle = 'rgba(0,0,0,0.25)'
		ctx.fillRect(0, 0, width, 2)
		ctx.fillRect(0, height - 2, width, 2)
		ctx.fillStyle = 'rgba(255,255,255,0.04)'
		for (let y = 0; y < height; y += 2) ctx.fillRect(0, y, width, 1)
	}

	// ---------- simulation ----------

	let lastPick = 0
	function activityFor(nextMode: SceneMode, moving: boolean): CharacterActivity {
		if (moving) return 'walk'
		if (nextMode === 'listen') return 'listen'
		if (nextMode === 'talk') return 'talk'
		return 'idle'
	}

	function clipNameFor(pose: CharacterPose) {
		return pose.reaction !== 'none' ? pose.reaction : `${pose.activity}_${pose.emotion}`
	}

	function setPose(pose: CharacterPose) {
		const nextClip = clipNameFor(pose)
		if (nextClip !== char.lastClip) {
			char.lastClip = nextClip
			char.clipElapsed = 0
		}
		char.pose = pose
	}

	function update(dt: number, now: number) {
		if (mode === 'roam') {
			if (now - lastPick > 2200 + rand() * 1400) {
				lastPick = now
				const ty = yFar() + 6 + rand() * (yNear() - yFar() - 8)
				const [lo, hi] = boundsAt(ty)
				char.tx = lo + rand() * (hi - lo)
				char.ty = ty
			}
		} else if (mode === 'listen') {
			// close-up: move past the near plane so the lower body clips off-screen
			char.tx = width / 2
			char.ty = yNear() + height * 0.25
		} else {
			char.tx = width * 0.72
			char.ty = yNear() - 3
		}

		// constant speed in px/ms, scaled by depth so "far" movement looks slower
		const base = mode === 'roam' ? 0.018 : 0.08
		const dx = char.tx - char.x
		const dy = char.ty - char.y
		const dist = Math.hypot(dx, dy)
		if (Math.abs(dx) > 0.4) char.facing = dx > 0 ? 1 : -1
		const step = base * scaleAt(char.y) * dt
		if (dist <= step || dist < 0.4) {
			char.x = char.tx
			char.y = char.ty
		} else {
			char.x += (dx / dist) * step
			char.y += (dy / dist) * step
		}

		setPose({
			activity: activityFor(mode, dist > 0.6),
			emotion: char.pose.emotion,
			reaction: now < char.pokeUntil ? 'poke' : 'none'
		})
		char.clipElapsed += dt
	}

	function render() {
		ctx.clearRect(0, 0, width, height)
		drawSky()
		drawHillBand(farHills, palette.far, 0.85)
		drawHillBand(midHills, palette.mid, 0.92)
		drawFog()
		drawHillBand(nearHills, palette.near, 1)
		drawGround()

		// y-sort props + character so nearer things draw over farther ones
		const drawables: Array<{ y: number; draw: () => void }> = []
		for (const p of props) drawables.push({ y: p.y, draw: () => renderProp(p) })
		drawables.push({ y: char.y, draw: renderCharacter })
		drawables.sort((a, b) => a.y - b.y)
		for (const d of drawables) d.draw()

		drawVignette()
	}

	// ---------- lifecycle ----------

	function resize() {
		const dpr = Math.min(2, window.devicePixelRatio || 1)
		const cw = canvas.clientWidth || 300
		const ch = canvas.clientHeight || 96
		canvas.width = Math.floor(cw * dpr)
		canvas.height = Math.floor(ch * dpr)
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		ctx.imageSmoothingEnabled = false
		width = cw
		height = ch
		rebuild()
	}

	let raf = 0
	let last = performance.now()
	function loop(now: number) {
		const dt = Math.min(48, now - last)
		last = now
		update(dt, now)
		render()
		raf = requestAnimationFrame(loop)
	}

	const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
	ro?.observe(canvas)
	resize()
	raf = requestAnimationFrame(loop)

	return {
		setMode(m) {
			if (m === mode) return
			mode = m
			if (m === 'roam') lastPick = 0
		},
		setSkin(skinId) {
			if (skinId === char.skinId) return
			char.skinId = skinId
		},
		setEmotion(emotion) {
			if (emotion === char.pose.emotion) return
			setPose({
				...char.pose,
				emotion
			})
		},
		setBiome(b) {
			biome = b
			rebuild()
		},
		poke() {
			char.pokeUntil = performance.now() + 400
		},
		regenerate(s) {
			seed = s ?? Math.floor(Math.random() * 1e9)
			rebuild()
		},
		destroy() {
			cancelAnimationFrame(raf)
			ro?.disconnect()
		}
	}
}

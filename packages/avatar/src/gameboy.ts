import type { Avatar } from './avatar.js'
import { type CanvasFrame, type CanvasSkin, canvasRenderer } from './canvas.js'

export const GAMEBOY_RESOLUTION = 256

type Mood = 'resting' | 'thinking' | 'pleased' | 'curious' | 'concerned' | 'apologetic'
type Pose = { y: number; turn: number; screen: number }
type Motion = Pose & { kick: number }

// Tweak these without changing the drawing order below.
const palette = {
	outline: '#10140b',
	shadow: 'rgba(8, 10, 6, 0.32)',
	softShadow: 'rgba(8, 10, 6, 0.16)',
	shellShade: '#8f8e7c',
	shell: '#cbc9b4',
	shellHighlight: '#e3e1cb',
	topShadow: '#aaa995',
	accent: '#b5374d',
	accentHighlight: '#d04d5e',
	bezel: '#11150c',
	screen: '#9cc900',
	screenShadow: '#789b00',
	ink: '#16320e',
	control: '#999886',
	controlShade: '#6f705f',
	scanline: 'rgba(36, 55, 13, 0.07)'
} as const

const timing = {
	expressionMs: 480,
	blinkCycleMs: 4200,
	blinkMs: 130,
	blinkOffsetMs: 1500,
	thoughtMs: 360
} as const

const idle = {
	bobSpeed: 1.8,
	bobDistance: 1.6,
	swaySpeed: 0.75,
	swayAngle: 0.012,
	jitterSpeed: 38,
	jitterDistance: 0.8,
	flickerSpeed: 0.041,
	flickerBase: 0.96,
	flickerDistance: 0.015
} as const

const faceLayout = {
	scale: 8,
	gap: 10,
	centerX: 120,
	y: 92,
	apologeticDrop: 7,
	curiousDistance: 2,
	curiousSpeed: 420
} as const

const motions: Record<Mood, Motion> = {
	resting: { y: 0, turn: 0, kick: 0, screen: 1 },
	thinking: { y: 1, turn: -0.055, kick: 1, screen: 0.96 },
	pleased: { y: -4, turn: 0, kick: 10, screen: 1.08 },
	curious: { y: -1, turn: 0.075, kick: 3, screen: 1 },
	concerned: { y: 3, turn: -0.025, kick: -2, screen: 0.88 },
	apologetic: { y: 6, turn: 0.035, kick: -1, screen: 0.78 }
}

const faces: Record<Mood, string> = {
	resting: 'o_o',
	thinking: 'o_.',
	pleased: '^_^',
	curious: 'o_?',
	concerned: '>_<',
	apologetic: ';_;'
}

const glyphs: Record<string, string[]> = {
	o: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
	_: ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
	'-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
	'^': ['00100', '01010', '10001', '00000', '00000', '00000', '00000'],
	'.': ['00000', '00000', '00000', '00000', '00000', '00110', '00110'],
	'?': ['01110', '10001', '00010', '00100', '00100', '00000', '00100'],
	'>': ['10000', '01000', '00100', '01000', '10000', '00000', '00000'],
	'<': ['00001', '00010', '00100', '00010', '00001', '00000', '00000'],
	';': ['00110', '00110', '00000', '00110', '00110', '00100', '01000']
}

export function drawGameboy(context: CanvasRenderingContext2D, frame: CanvasFrame) {
	const mood = toMood(frame.expression)
	const previousMood = toMood(frame.previousExpression)
	const seconds = frame.time / 1000
	const change = frame.reducedMotion
		? 1
		: ease(Math.min(1, (frame.time - frame.expressionChangedAt) / timing.expressionMs))
	const bob = frame.reducedMotion ? 0 : Math.sin(seconds * idle.bobSpeed) * idle.bobDistance
	const sway = frame.reducedMotion ? 0 : Math.sin(seconds * idle.swaySpeed) * idle.swayAngle
	const kick = frame.reducedMotion ? 0 : Math.sin(change * Math.PI) * motions[mood].kick
	const current = mixMotion(motions[previousMood], motions[mood], change)
	const jitter =
		mood === 'concerned' && !frame.reducedMotion
			? Math.sin(seconds * idle.jitterSpeed) * idle.jitterDistance
			: 0

	context.clearRect(0, 0, context.canvas.width, context.canvas.height)
	// The floor shadow stays put while the computer moves above it.
	drawShadow(context, bob, current)

	// Bob, turn, squash, and emotion kicks move the whole computer as one piece.
	context.save()
	context.translate(128 + jitter, 126 + bob + current.y - kick)
	context.rotate(sway + current.turn)
	context.scale(1 + kick * 0.003, 1 - kick * 0.002)
	context.translate(-128, -126)
	drawComputer(context, frame, mood, current)
	context.restore()
}

function drawShadow(context: CanvasRenderingContext2D, bob: number, current: Pose) {
	const lift = Math.max(0, -current.y + bob)
	// Two hard-edged strips read as one soft shadow at avatar size.
	context.fillStyle = palette.shadow
	context.fillRect(51 + lift * 0.2, 230, 154 - lift * 0.4, 6)
	context.fillStyle = palette.softShadow
	context.fillRect(43 + lift * 0.1, 236, 170 - lift * 0.2, 3)
}

function drawComputer(
	context: CanvasRenderingContext2D,
	frame: CanvasFrame,
	mood: Mood,
	current: Pose
) {
	context.imageSmoothingEnabled = false

	// Dark back plate and offset foot give the case its depth.
	context.fillStyle = palette.outline
	pixelBox(context, 27, 17, 207, 207, 7)
	context.fillRect(39, 224, 183, 8)

	// Layered stepped boxes form the rounded plastic shell.
	context.fillStyle = palette.shellShade
	pixelBox(context, 32, 22, 195, 203, 6)
	context.fillStyle = palette.shell
	pixelBox(context, 20, 29, 197, 195, 7)
	// Follow the shell steps so the highlight does not square off its corners.
	context.fillStyle = palette.shellHighlight
	context.fillRect(27, 29, 183, 4)
	context.fillRect(24, 33, 189, 3)
	context.fillRect(20, 36, 197, 1)
	context.fillRect(20, 37, 8, 180)
	context.fillStyle = palette.topShadow
	context.fillRect(28, 37, 189, 6)

	// The red side tab breaks up the large pale case.
	context.fillStyle = palette.accent
	context.fillRect(28, 106, 8, 24)

	// The dark inset band touches the bezel so it reads as its cast shadow.
	context.fillStyle = palette.bezel
	pixelBox(context, 36, 48, 169, 151, 5)
	context.fillStyle = palette.screen
	pixelBox(context, 46, 58, 149, 131, 4)
	context.fillStyle = palette.screenShadow
	context.fillRect(46, 58, 149, 8)

	// The face and scanlines share the faint LCD flicker.
	const flicker = frame.reducedMotion
		? 1
		: idle.flickerBase + Math.sin(frame.time * idle.flickerSpeed) * idle.flickerDistance
	context.globalAlpha = flicker * current.screen
	drawFace(context, frame, mood)
	drawScanlines(context)
	context.globalAlpha = 1

	// Small lower controls hint at hardware without competing with the face.
	context.fillStyle = palette.control
	context.fillRect(63, 207, 92, 5)
	context.fillStyle = palette.controlShade
	context.fillRect(46, 207, 9, 5)
	context.fillStyle = palette.accent
	context.fillRect(184, 206, 11, 11)
	context.fillStyle = palette.accentHighlight
	context.fillRect(186, 206, 9, 3)

	// Thinking is the only mood that draws beyond the computer case.
	if (mood === 'thinking') drawThought(context, frame)
}

function drawFace(context: CanvasRenderingContext2D, frame: CanvasFrame, mood: Mood) {
	const blinking =
		!frame.reducedMotion &&
		(frame.time + timing.blinkOffsetMs) % timing.blinkCycleMs < timing.blinkMs
	const face = blinking ? '-_-' : faces[mood]
	const { scale, gap } = faceLayout
	const glyphWidth = 5 * scale
	const width = face.length * glyphWidth + (face.length - 1) * gap
	let x = faceLayout.centerX - width / 2
	let y = faceLayout.y

	if (mood === 'apologetic') y += faceLayout.apologeticDrop
	if (mood === 'curious' && !frame.reducedMotion) {
		x += Math.sin(frame.time / faceLayout.curiousSpeed) * faceLayout.curiousDistance
	}

	// Each character is a 5 by 7 bitmap, so the face stays crisp when scaled down.
	context.fillStyle = palette.ink
	for (const char of face) {
		drawGlyph(context, char, Math.round(x), Math.round(y), scale)
		x += glyphWidth + gap
	}
}

function drawGlyph(
	context: CanvasRenderingContext2D,
	char: string,
	x: number,
	y: number,
	scale: number
) {
	const rows = glyphs[char]
	if (!rows) return
	for (const [rowIndex, row] of rows.entries()) {
		for (let column = 0; column < row.length; column++) {
			if (row[column] === '1') {
				context.fillRect(x + column * scale, y + rowIndex * scale, scale, scale)
			}
		}
	}
}

function pixelBox(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	cut: number
) {
	// Overlapping rectangles cut the corners without anti-aliased curves.
	const step = Math.ceil(cut / 2)
	context.fillRect(x + cut, y, width - cut * 2, height)
	context.fillRect(x, y + cut, width, height - cut * 2)
	context.fillRect(x + step, y + step, width - step * 2, height - step * 2)
}

function drawScanlines(context: CanvasRenderingContext2D) {
	// Sparse one-pixel rows keep the LCD texture visible at 46px.
	context.fillStyle = palette.scanline
	for (let y = 67; y < 189; y += 5) context.fillRect(46, y, 149, 1)
}

function drawThought(context: CanvasRenderingContext2D, frame: CanvasFrame) {
	// Three pixels climb away from the bezel one at a time.
	const step = frame.reducedMotion ? 2 : Math.floor(frame.time / timing.thoughtMs) % 3
	context.fillStyle = palette.screen
	for (let index = 0; index <= step; index++) {
		context.fillRect(207 + index * 8, 67 - index * 7, 5, 5)
	}
}

function mixMotion(from: Motion, to: Motion, amount: number): Pose {
	return {
		y: mix(from.y, to.y, amount),
		turn: mix(from.turn, to.turn, amount),
		screen: mix(from.screen, to.screen, amount)
	}
}

function mix(from: number, to: number, amount: number) {
	return from + (to - from) * amount
}

function ease(amount: number) {
	return 1 - (1 - amount) ** 3
}

function toMood(expression: string | null): Mood {
	return expression && expression in motions ? (expression as Mood) : 'resting'
}

export const gameboySkin = {
	id: 'gameboy',
	width: GAMEBOY_RESOLUTION,
	height: GAMEBOY_RESOLUTION,
	draw: drawGameboy
} as const satisfies CanvasSkin

export const gameboyAvatar = {
	renderer: canvasRenderer,
	skin: gameboySkin
} as const satisfies Avatar<CanvasSkin>

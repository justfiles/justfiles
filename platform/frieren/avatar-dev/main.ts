import { EXPRESSIONS, type Expression } from '@justfiles/agent/expression'
import type { CanvasFrame } from '../src/agent/CanvasAvatar'
import { drawGameboy } from '../src/agent/skins/gameboy'
import './style.css'

const FRAME_MS = 1000 / 30

type Mood = Expression | 'resting'
type Draw = typeof drawGameboy

const preview = required<HTMLCanvasElement>('preview')
const dock = required<HTMLCanvasElement>('dock')
const moods = required<HTMLDivElement>('moods')
const size = required<HTMLInputElement>('size')
const sizeOutput = required<HTMLOutputElement>('size-output')
const contexts = [preview, dock].map((canvas) => {
	const context = canvas.getContext('2d')
	if (!context) throw new Error('Canvas 2D is unavailable')
	return context
})
const motion = matchMedia('(prefers-reduced-motion: reduce)')

let draw: Draw = drawGameboy
let mood: Mood = 'resting'
let previousMood: Mood = 'resting'
let expressionChangedAt = performance.now()

for (const nextMood of ['resting', ...EXPRESSIONS] as Mood[]) {
	const button = document.createElement('button')
	button.type = 'button'
	button.textContent = nextMood
	button.dataset.mood = nextMood
	button.dataset.selected = String(nextMood === mood)
	button.addEventListener('click', () => {
		previousMood = mood
		mood = nextMood
		expressionChangedAt = performance.now()
		for (const element of moods.children) {
			if (element instanceof HTMLButtonElement) {
				element.dataset.selected = String(element === button)
			}
		}
	})
	moods.append(button)
}

size.addEventListener('input', () => {
	preview.style.width = `${size.value}px`
	preview.style.height = `${size.value}px`
	sizeOutput.value = `${size.value}px`
})

let lastPaint = -FRAME_MS
function paint(time: number) {
	requestAnimationFrame(paint)
	if (time - lastPaint < FRAME_MS) return
	lastPaint = time
	const frame: CanvasFrame = {
		time,
		expression: mood === 'resting' ? null : mood,
		previousExpression: previousMood === 'resting' ? null : previousMood,
		expressionChangedAt,
		reducedMotion: motion.matches
	}
	for (const context of contexts) draw(context, frame)
}
requestAnimationFrame(paint)

import.meta.hot?.accept('../src/agent/skins/gameboy', (module) => {
	if (module) draw = module.drawGameboy
})

function required<Element extends HTMLElement>(id: string): Element {
	const element = document.getElementById(id)
	if (!element) throw new Error(`Missing #${id}`)
	return element as Element
}

import '@justfiles/app/client'
import { DOOM } from 'wasm-doom'
import './index.css'

const WIDTH = 640
const HEIGHT = 400
const KEY = {
	comma: 44,
	ctrl: 17,
	down: 40,
	left: 37,
	period: 46,
	right: 39,
	shift: 16,
	space: 32,
	up: 38
} as const

type DoomStatus = 'loading' | 'running' | 'error'

type DoomState = {
	status: DoomStatus
	frames: number
	fps: number
	lastFrameAt?: number
	error?: string
}

const root = document.querySelector<HTMLDivElement>('#root')

if (!root) throw new Error('missing #root')

mountDoom(root)

function mountDoom(root: HTMLElement) {
	const canvas = document.createElement('canvas')
	const bindings = document.createElement('div')
	const keyboard = document.createElement('div')
	const monitor = document.createElement('output')
	const ctx = canvas.getContext('2d')
	if (!ctx) throw new Error('canvas 2d context unavailable')

	const state: DoomState = { status: 'loading', frames: 0, fps: 0 }
	let secondStartedAt = performance.now()
	let secondFrames = 0

	canvas.width = WIDTH
	canvas.height = HEIGHT
	bindings.className = 'bindings'
	bindings.textContent =
		'W/S move | A/D strafe | E or Space use | Shift run | Click fire | Mouse turn'
	keyboard.hidden = true
	monitor.className = 'monitor'
	root.tabIndex = 0
	root.replaceChildren(canvas, bindings, keyboard, monitor)
	root.addEventListener('pointerdown', () => root.focus(), { passive: true })
	root.focus()
	bindInput(canvas, keyboard)

	const update = (patch: Partial<DoomState>) => {
		Object.assign(state, patch)
		monitor.value =
			state.status === 'error'
				? `error: ${state.error ?? 'unknown'}`
				: `${state.status} | ${state.fps} fps | ${state.frames} frames`
	}

	update({})

	const game = new DOOM({
		screenWidth: WIDTH,
		screenHeight: HEIGHT,
		keyboardTarget: keyboard,
		onFrameRender: ({ screen }) => {
			const now = performance.now()
			state.frames++
			secondFrames++
			if (now - secondStartedAt >= 1000) {
				state.fps = Math.round((secondFrames * 1000) / (now - secondStartedAt))
				secondFrames = 0
				secondStartedAt = now
			}
			ctx.putImageData(new ImageData(screen, WIDTH, HEIGHT), 0, 0)
			update({ status: 'running', lastFrameAt: now })
		}
	})

	void game.start().catch((error) => {
		update({ status: 'error', error: error instanceof Error ? error.message : String(error) })
	})

	return {
		canvas,
		getState: () => ({ ...state })
	}
}

function bindInput(canvas: HTMLCanvasElement, keyboard: HTMLElement) {
	const remap: Record<string, number> = {
		Comma: KEY.comma,
		KeyA: KEY.comma,
		KeyD: KEY.period,
		KeyE: KEY.space,
		KeyS: KEY.down,
		KeyW: KEY.up,
		Period: KEY.period,
		ShiftLeft: KEY.shift,
		ShiftRight: KEY.shift,
		Space: KEY.space
	}
	const pressed = new Set<number>()

	const press = (keyCode: number) => {
		if (pressed.has(keyCode)) return
		pressed.add(keyCode)
		emit(keyboard, 'keydown', keyCode)
	}
	const release = (keyCode: number) => {
		if (!pressed.delete(keyCode)) return
		emit(keyboard, 'keyup', keyCode)
	}

	window.addEventListener('keydown', (event) => {
		if (event.repeat) return
		const keyCode = remap[event.code] ?? event.keyCode
		event.preventDefault()
		press(keyCode)
	})
	window.addEventListener('keyup', (event) => {
		const keyCode = remap[event.code] ?? event.keyCode
		event.preventDefault()
		release(keyCode)
	})
	canvas.addEventListener('click', () => canvas.requestPointerLock())
	canvas.addEventListener('mousedown', (event) => {
		event.preventDefault()
		press(event.button === 2 ? KEY.space : KEY.ctrl)
	})
	canvas.addEventListener('mouseup', (event) => {
		event.preventDefault()
		release(event.button === 2 ? KEY.space : KEY.ctrl)
	})
	canvas.addEventListener('contextmenu', (event) => event.preventDefault())
	document.addEventListener('pointermove', (event) => {
		if (document.pointerLockElement !== canvas) return
		tap(keyboard, event.movementX < 0 ? KEY.left : KEY.right, Math.abs(event.movementX))
	})
	window.addEventListener('blur', () => {
		for (const keyCode of pressed) emit(keyboard, 'keyup', keyCode)
		pressed.clear()
	})
}

function tap(target: HTMLElement, keyCode: number, amount: number) {
	if (amount < 1) return
	emit(target, 'keydown', keyCode)
	setTimeout(() => emit(target, 'keyup', keyCode), Math.min(80, 12 + amount * 2))
}

function emit(target: HTMLElement, type: 'keydown' | 'keyup', keyCode: number) {
	const event = new KeyboardEvent(type, {
		bubbles: true,
		cancelable: true,
		keyCode,
		which: keyCode
	})
	Object.defineProperty(event, 'keyCode', { get: () => keyCode })
	Object.defineProperty(event, 'which', { get: () => keyCode })
	target.dispatchEvent(event)
}

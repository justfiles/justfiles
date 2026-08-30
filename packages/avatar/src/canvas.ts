import type { Avatar, AvatarFrame, AvatarHandle, AvatarState } from './avatar.js'
import { RasterContext } from './raster.js'

const FRAME_MS = 1000 / 30
const RESTING: AvatarState = { expression: null }

interface AvatarOptions {
	readonly id: string
	readonly width: number
	readonly height: number
	draw(context: CanvasRenderingContext2D, frame: AvatarFrame): void
}

/** Build a Canvas avatar that can mount live or render to RGBA. */
export function avatar({ id, width, height, draw }: AvatarOptions): Avatar {
	return {
		id,
		mount(host, state = RESTING) {
			host.dataset.avatar = id
			host.dataset.expression = state.expression ?? 'resting'
			const handle = mountCanvas(host, width, height, draw, state)
			return {
				update(next) {
					host.dataset.expression = next.expression ?? 'resting'
					handle.update(next)
				},
				destroy() {
					handle.destroy()
					delete host.dataset.avatar
					delete host.dataset.expression
				}
			}
		},
		render(state = RESTING) {
			const context = new RasterContext(width, height)
			draw(context as unknown as CanvasRenderingContext2D, {
				time: 0,
				expression: state.expression,
				previousExpression: state.expression,
				expressionChangedAt: 0,
				reducedMotion: true
			})
			return { width, height, data: context.pixels }
		}
	}
}

function mountCanvas(
	host: HTMLElement,
	width: number,
	height: number,
	drawFrame: AvatarOptions['draw'],
	initial: AvatarState
): AvatarHandle {
	const canvas = document.createElement('canvas')
	canvas.width = width
	canvas.height = height
	canvas.setAttribute('aria-hidden', 'true')
	canvas.style.display = 'block'
	canvas.style.width = '100%'
	canvas.style.height = '100%'
	const context = canvas.getContext('2d')
	if (!context) throw new Error('Canvas 2D is not available')
	host.replaceChildren(canvas)

	const startedAt = performance.now()
	const motion = matchMedia('(prefers-reduced-motion: reduce)')
	let expression = initial.expression
	let previousExpression = initial.expression
	let expressionChangedAt = startedAt
	let request = 0
	let lastPaint = startedAt

	const draw = (now: number) => {
		lastPaint = now
		drawFrame(context, {
			time: now - startedAt,
			expression,
			previousExpression,
			expressionChangedAt: expressionChangedAt - startedAt,
			reducedMotion: motion.matches
		})
	}

	const paint = (now: number) => {
		request = 0
		if (now - lastPaint >= FRAME_MS) draw(now)
		if (!document.hidden && !motion.matches) request = requestAnimationFrame(paint)
	}

	const schedule = () => {
		cancelAnimationFrame(request)
		request = 0
		if (!document.hidden && !motion.matches) request = requestAnimationFrame(paint)
	}

	const syncVisibility = () => {
		if (!document.hidden && motion.matches) draw(performance.now())
		schedule()
	}

	const syncMotion = () => {
		if (!document.hidden) draw(performance.now())
		schedule()
	}

	draw(startedAt)
	schedule()
	document.addEventListener('visibilitychange', syncVisibility)
	motion.addEventListener('change', syncMotion)

	return {
		update(state) {
			if (state.expression === expression) return
			previousExpression = expression
			expression = state.expression
			expressionChangedAt = performance.now()
			if (motion.matches && !document.hidden) draw(expressionChangedAt)
		},
		destroy() {
			cancelAnimationFrame(request)
			document.removeEventListener('visibilitychange', syncVisibility)
			motion.removeEventListener('change', syncMotion)
			canvas.remove()
		}
	}
}

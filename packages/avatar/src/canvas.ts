import type { AvatarRenderer, AvatarSkin } from './avatar.js'

const FRAME_MS = 1000 / 30

export interface CanvasFrame {
	time: number
	expression: string | null
	previousExpression: string | null
	expressionChangedAt: number
	reducedMotion: boolean
}

export interface CanvasSkin extends AvatarSkin {
	readonly width: number
	readonly height: number
	draw(context: CanvasRenderingContext2D, frame: CanvasFrame): void
}

export const canvasRenderer: AvatarRenderer<CanvasSkin> = {
	id: 'canvas',
	mount(host, skin, initial) {
		const canvas = document.createElement('canvas')
		canvas.width = skin.width
		canvas.height = skin.height
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
			skin.draw(context, {
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
}

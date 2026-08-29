import type { Expression } from '@justfiles/agent/expression'
import { useEffect, useRef } from 'react'
import type { AvatarAppearance } from './avatarAppearance'
import { drawGameboy } from './skins/gameboy'

const SIZE = 256
const FRAME_MS = 1000 / 30
const skins = { gameboy: drawGameboy }

type CanvasAppearance = Extract<AvatarAppearance, { renderer: 'canvas' }>

export type CanvasFrame = {
	time: number
	expression: Expression | null
	previousExpression: Expression | null
	expressionChangedAt: number
	reducedMotion: boolean
}

export function CanvasAvatar({
	appearance,
	expression,
	personalized,
	size,
	className
}: {
	appearance: CanvasAppearance
	expression: Expression | null
	personalized: boolean
	size: number
	className?: string
}) {
	const canvas = useRef<HTMLCanvasElement>(null)
	const state = useRef({
		expression,
		previousExpression: expression,
		changedAt: 0
	})

	useEffect(() => {
		state.current = {
			expression,
			previousExpression: state.current.expression,
			changedAt: performance.now()
		}
	}, [expression])

	useEffect(() => {
		const element = canvas.current
		const context = element?.getContext('2d')
		if (!element || !context) return
		const motion = matchMedia('(prefers-reduced-motion: reduce)')
		const draw = skins[appearance.skin]
		let request = 0
		let lastPaint = -FRAME_MS

		const paint = (time: number) => {
			request = requestAnimationFrame(paint)
			if (time - lastPaint < FRAME_MS) return
			lastPaint = time
			const current = state.current
			draw(context, {
				time,
				expression: current.expression,
				previousExpression: current.previousExpression,
				expressionChangedAt: current.changedAt,
				reducedMotion: motion.matches
			})
		}

		const syncVisibility = () => {
			cancelAnimationFrame(request)
			request = document.hidden ? 0 : requestAnimationFrame(paint)
		}
		syncVisibility()
		document.addEventListener('visibilitychange', syncVisibility)
		return () => {
			cancelAnimationFrame(request)
			document.removeEventListener('visibilitychange', syncVisibility)
		}
	}, [appearance.skin])

	return (
		<canvas
			ref={canvas}
			width={SIZE}
			height={SIZE}
			className={className ? `frn-agent-avatar ${className}` : 'frn-agent-avatar'}
			data-renderer="canvas"
			data-skin={appearance.skin}
			data-personalized={personalized}
			data-expression={expression ?? 'resting'}
			style={{ width: size, height: size }}
			title={expression ?? undefined}
		/>
	)
}

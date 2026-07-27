import type { Expression } from '@justfiles/agent/expression'
import { useEffect, useRef, useState } from 'react'

// How long a face stays put before the next tag can replace it — tags arrive per sentence,
// which is faster than an eye can follow.
const MIN_HOLD_MS = 1_500
// After the reply lands, the face drifts back to its resting expression.
const REST_DELAY_MS = 4_000

export interface AgentAvatarProps {
	// Base face, always present (bundled default, chosen archetype, or uploaded photo).
	url: string
	// Optional per-expression faces from the volume; absent ones fall back to `url`.
	faces: Partial<Record<Expression, string>>
	// Latest tag off the token stream, or null before the agent has tagged anything.
	expression: Expression | null
	streaming: boolean
	personalized: boolean
	size: number
}

/**
 * The agent's face: the tag stream picks the image, a minimum hold keeps per-sentence tags
 * from strobing, and the face drifts back to `neutral` once the reply is over. With no
 * per-expression art on the volume every expression resolves to the same image and this is
 * a plain avatar — the channel still runs, and shows up as `data-expression`.
 */
export function AgentAvatar({
	url,
	faces,
	expression,
	streaming,
	personalized,
	size
}: AgentAvatarProps) {
	const shown = useHeldExpression(expression, streaming)
	return (
		<img
			src={(shown && faces[shown]) || url}
			alt=""
			width={size}
			height={size}
			className="frn-agent-avatar"
			data-personalized={personalized}
			data-expression={shown ?? 'neutral'}
			title={shown ?? undefined}
		/>
	)
}

function useHeldExpression(expression: Expression | null, streaming: boolean): Expression | null {
	const [shown, setShown] = useState<Expression | null>(null)
	const changedAt = useRef(0)

	// Rate-limit: never swap faces more often than MIN_HOLD_MS.
	useEffect(() => {
		if (expression === shown) return
		const timer = setTimeout(
			() => {
				changedAt.current = Date.now()
				setShown(expression)
			},
			Math.max(0, MIN_HOLD_MS - (Date.now() - changedAt.current))
		)
		return () => clearTimeout(timer)
	}, [expression, shown])

	// Settle back to resting once the turn is done. (When mood lands, this is where the
	// resting face becomes a function of mood instead of a constant.)
	useEffect(() => {
		if (streaming || shown === null || shown === 'neutral') return
		const timer = setTimeout(() => setShown('neutral'), REST_DELAY_MS)
		return () => clearTimeout(timer)
	}, [streaming, shown])

	return shown
}

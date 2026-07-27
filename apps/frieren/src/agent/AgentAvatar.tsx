import type { Expression } from '@justfiles/agent/expression'
import { useEffect, useState } from 'react'

// After the reply lands, the face drifts back to its resting expression. (When mood
// arrives, this is where the resting face becomes a function of mood, not a constant.)
const REST_DELAY_MS = 4_000

export interface AgentAvatarProps {
	// Base face, always present (bundled default, chosen archetype, or uploaded photo).
	url: string
	// Optional per-expression faces from the volume; absent ones fall back to `url`.
	faces: Partial<Record<Expression, string>>
	// The expression the client is currently publishing. It already paces the agent's
	// per-sentence tags (one per hold), so this component just renders what it's given.
	expression: Expression | null
	streaming: boolean
	personalized: boolean
	size: number
	// Extra class for a host that positions/sizes the face itself (the omnibar's
	// travelling chip → shoulder); `size` stays as the intrinsic attribute.
	className?: string
}

/**
 * The agent's face: the expression picks the image, and the face settles back to `neutral`
 * once the reply is over. With no per-expression art on the volume every expression
 * resolves to the same image and this is a plain avatar — the channel still runs, and shows
 * up as `data-expression`.
 */
export function AgentAvatar({
	url,
	faces,
	expression,
	streaming,
	personalized,
	size,
	className
}: AgentAvatarProps) {
	const shown = useRestingExpression(expression, streaming)
	return (
		<img
			src={(shown && faces[shown]) || url}
			alt=""
			width={size}
			height={size}
			className={className ? `frn-agent-avatar ${className}` : 'frn-agent-avatar'}
			data-personalized={personalized}
			data-expression={shown ?? 'neutral'}
			title={shown ?? undefined}
		/>
	)
}

function useRestingExpression(
	expression: Expression | null,
	streaming: boolean
): Expression | null {
	const [resting, setResting] = useState(false)
	useEffect(() => {
		setResting(false)
		if (streaming || expression === null || expression === 'neutral') return
		const timer = setTimeout(() => setResting(true), REST_DELAY_MS)
		return () => clearTimeout(timer)
	}, [streaming, expression])
	return resting ? 'neutral' : expression
}

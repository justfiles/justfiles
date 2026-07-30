import type { Expression } from '@justfiles/agent/expression'
import { useEffect, useState } from 'react'

// After the reply lands, the face drifts back to its resting expression. The delay is a
// READING window, not an animation beat: the expression belongs to the sentence the user
// is still reading, so it has to outlast the reply on screen (~200 wpm over a few
// sentences, plus the beat before they answer). At 4s the face snapped to neutral mid-read
// and the channel looked like a flicker. The face also resets on the next turn
// (`agent_start`), so this timer only decides how long a held emotion survives silence.
// (When mood arrives, this is where the resting face becomes a function of mood, not a
// constant.)
const REST_DELAY_MS = 18_000

export interface AgentAvatarProps {
	// Base face, always present (bundled default, chosen archetype, or uploaded photo).
	url: string
	// Optional per-expression faces from the volume; absent ones fall back to `url`.
	faces: Partial<Record<Expression, string>>
	// The agent's latest expression tag — last tag wins, so a reply that tags several
	// sentences ends on its final one.
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
 * once the reply is over. A built-in variant ships art for every expression; an uploaded
 * photo has one image until the engine derives the rest, and then every expression resolves
 * to the same picture — which is what `data-art` tells the stylesheet.
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
	const art = shown ? faces[shown] : undefined
	return (
		<img
			src={art || url}
			alt=""
			width={size}
			height={size}
			className={className ? `frn-agent-avatar ${className}` : 'frn-agent-avatar'}
			data-personalized={personalized}
			data-expression={shown ?? 'neutral'}
			// Whether the expression is really on screen or only being stood in for: a built-in
			// variant and a fully derived photo have art per expression, an uploaded photo has one
			// image until the engine catches up. The CSS treatment belongs to the second case only.
			data-art={art ? 'face' : 'fallback'}
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

import type { Expression } from '@justfiles/agent/expression'
import { useEffect, useState } from 'react'
import type { AvatarAppearance } from './avatarAppearance'
import { CanvasAvatar } from './CanvasAvatar'
import { ImageAvatar } from './ImageAvatar'

// After the reply lands, the face drifts back to rest. The delay is a READING window, not an
// animation beat: the expression belongs to the sentence the user is still reading, so it has
// to outlast the reply on screen (~200 wpm over a few sentences, plus the beat before they
// answer). At 4s the face snapped back mid-read and the channel looked like a flicker. This is
// the CAP on a held emotion; the floor is the client's minimum hold. The face also resets on
// the next turn (`agent_start`), so this timer only decides how long an emotion survives
// silence. (When mood arrives, this is where the resting face becomes a function of mood,
// rather than the one image it is now.)
const REST_DELAY_MS = 18_000

export interface AgentAvatarProps {
	appearance: AvatarAppearance
	// The agent's latest expression tag — last tag wins, so a reply that tags several
	// sentences ends on its final one.
	expression: Expression | null
	streaming: boolean
	personalized: boolean
	size: number
	// Extra class for a host that positions or sizes the face itself.
	className?: string
}

/** The agent's face, rendered from its current appearance and held expression. */
export function AgentAvatar({
	appearance,
	expression,
	streaming,
	personalized,
	size,
	className
}: AgentAvatarProps) {
	const shown = useRestingExpression(expression, streaming)
	const props = { expression: shown, personalized, size, className }
	return appearance.renderer === 'image' ? (
		<ImageAvatar appearance={appearance} {...props} />
	) : (
		<CanvasAvatar appearance={appearance} {...props} />
	)
}

function useRestingExpression(
	expression: Expression | null,
	streaming: boolean
): Expression | null {
	const [resting, setResting] = useState(false)
	useEffect(() => {
		setResting(false)
		if (streaming || expression === null) return
		const timer = setTimeout(() => setResting(true), REST_DELAY_MS)
		return () => clearTimeout(timer)
	}, [streaming, expression])
	return resting ? null : expression
}

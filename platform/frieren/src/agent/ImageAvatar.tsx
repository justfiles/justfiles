import type { Expression } from '@justfiles/agent/expression'
import type { AvatarAppearance } from './avatarAppearance'

type ImageAppearance = Extract<AvatarAppearance, { renderer: 'image' }>

export function ImageAvatar({
	appearance,
	expression,
	personalized,
	size,
	className
}: {
	appearance: ImageAppearance
	expression: Expression | null
	personalized: boolean
	size: number
	className?: string
}) {
	const art = expression ? appearance.faces[expression] : undefined
	return (
		<img
			src={art || appearance.url}
			alt=""
			width={size}
			height={size}
			className={className ? `frn-agent-avatar ${className}` : 'frn-agent-avatar'}
			data-renderer="image"
			data-personalized={personalized}
			data-expression={expression ?? 'resting'}
			data-art={art ? 'face' : 'fallback'}
			title={expression ?? undefined}
		/>
	)
}

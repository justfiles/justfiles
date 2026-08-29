import { type HTMLAttributes, useEffect, useRef } from 'react'
import {
	type AvatarHandle,
	type AvatarSkin,
	type Avatar as AvatarSpec,
	mountAvatar
} from './avatar.js'
import { gameboyAvatar } from './gameboy.js'

export interface AvatarProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
	avatar: AvatarSpec<AvatarSkin>
	expression?: string | null
}

export function Avatar({ avatar, expression = null, ...props }: AvatarProps) {
	const host = useRef<HTMLSpanElement>(null)
	const handle = useRef<AvatarHandle>(null)
	const currentExpression = useRef(expression)
	currentExpression.current = expression

	useEffect(() => {
		if (!host.current) return
		handle.current = mountAvatar(host.current, avatar, {
			expression: currentExpression.current
		})
		return () => {
			handle.current?.destroy()
			handle.current = null
		}
	}, [avatar])

	useEffect(() => handle.current?.update({ expression }), [expression])

	return (
		<span
			{...props}
			ref={host}
			data-renderer={avatar.renderer.id}
			data-skin={avatar.skin.id}
			data-expression={expression ?? 'resting'}
		/>
	)
}

export type GameboyAvatarProps = Omit<AvatarProps, 'avatar'>

export function GameboyAvatar(props: GameboyAvatarProps) {
	return <Avatar aria-label="Game Boy avatar" role="img" {...props} avatar={gameboyAvatar} />
}

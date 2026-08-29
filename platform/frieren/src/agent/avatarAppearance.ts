import type { Expression } from '@justfiles/agent/expression'

export type AvatarAppearance =
	| {
			renderer: 'image'
			url: string
			faces: Partial<Record<Expression, string>>
	  }
	| {
			renderer: 'canvas'
			skin: 'gameboy'
	  }

export const GAMEBOY_AVATAR = {
	renderer: 'canvas',
	skin: 'gameboy'
} as const satisfies AvatarAppearance

export interface AvatarState {
	readonly expression: string | null
}

export interface AvatarFrame extends AvatarState {
	readonly time: number
	readonly previousExpression: string | null
	readonly expressionChangedAt: number
	readonly reducedMotion: boolean
}

export interface AvatarImage {
	readonly width: number
	readonly height: number
	readonly data: Uint8Array
}

export interface AvatarHandle {
	update(state: AvatarState): void
	destroy(): void
}

export interface Avatar {
	readonly id: string
	mount(host: HTMLElement, state?: AvatarState): AvatarHandle
	render(state?: AvatarState): AvatarImage
}

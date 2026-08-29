export interface AvatarState {
	expression: string | null
}

export interface AvatarSkin {
	readonly id: string
}

export interface AvatarHandle {
	update(state: AvatarState): void
	destroy(): void
}

export interface AvatarRenderer<Skin extends AvatarSkin> {
	readonly id: string
	mount(host: HTMLElement, skin: Skin, state: AvatarState): AvatarHandle
}

export interface Avatar<Skin extends AvatarSkin> {
	readonly renderer: AvatarRenderer<Skin>
	readonly skin: Skin
}

/** Mount an avatar into an empty host element. The returned handle owns its children. */
export function mountAvatar<Skin extends AvatarSkin>(
	host: HTMLElement,
	avatar: Avatar<Skin>,
	state: AvatarState
): AvatarHandle {
	host.dataset.renderer = avatar.renderer.id
	host.dataset.skin = avatar.skin.id
	host.dataset.expression = state.expression ?? 'resting'
	const handle = avatar.renderer.mount(host, avatar.skin, state)

	return {
		update(next) {
			host.dataset.expression = next.expression ?? 'resting'
			handle.update(next)
		},
		destroy() {
			handle.destroy()
			delete host.dataset.renderer
			delete host.dataset.skin
			delete host.dataset.expression
		}
	}
}

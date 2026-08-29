import type { AvatarRenderer, AvatarSkin, AvatarState } from './avatar.js'

export interface ImageSkin extends AvatarSkin {
	readonly src: string
	readonly faces?: Readonly<Record<string, string | undefined>>
}

export const imageRenderer: AvatarRenderer<ImageSkin> = {
	id: 'image',
	mount(host, skin, state) {
		const image = document.createElement('img')
		image.alt = ''
		image.draggable = false
		image.decoding = 'async'
		image.style.display = 'block'
		image.style.width = '100%'
		image.style.height = '100%'
		image.style.objectFit = 'cover'
		host.replaceChildren(image)

		const update = (next: AvatarState) => {
			const face = next.expression ? skin.faces?.[next.expression] : undefined
			image.src = face ?? skin.src
			host.dataset.art = face ? 'face' : 'fallback'
		}
		update(state)

		return {
			update,
			destroy() {
				image.remove()
				delete host.dataset.art
			}
		}
	}
}

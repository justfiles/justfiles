import { imageRenderer } from '@justfiles/avatar'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { AgentAvatar } from './AgentAvatar'
import { GAMEBOY_AVATAR } from './avatarAppearance'

test('renders the selected avatar renderer', () => {
	const common = {
		expression: 'pleased' as const,
		streaming: true,
		personalized: false,
		size: 48
	}
	const image = renderToStaticMarkup(
		createElement(AgentAvatar, {
			appearance: {
				renderer: imageRenderer,
				skin: {
					id: 'portrait',
					src: 'resting.png',
					faces: { pleased: 'pleased.png' }
				}
			},
			...common
		})
	)
	const canvas = renderToStaticMarkup(
		createElement(AgentAvatar, { appearance: GAMEBOY_AVATAR, ...common })
	)

	expect(image).toContain('data-skin="portrait"')
	expect(image).toContain('data-renderer="image"')
	expect(canvas).toContain('<span')
	expect(canvas).toContain('data-skin="gameboy"')
})

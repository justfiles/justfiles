import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { AgentAvatar } from './AgentAvatar'
import { GAMEBOY_AVATAR } from './avatarAppearance'

test('renders the selected avatar', () => {
	const common = {
		expression: 'pleased' as const,
		streaming: true,
		personalized: false,
		size: 48
	}
	const html = renderToStaticMarkup(
		createElement(AgentAvatar, {
			appearance: { ...GAMEBOY_AVATAR, id: 'portrait' },
			...common
		})
	)

	expect(html).toContain('<span')
	expect(html).toContain('data-avatar="portrait"')
})

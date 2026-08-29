import { expect, test, vi } from 'vitest'
import { type AvatarRenderer, type AvatarSkin, mountAvatar } from './avatar.js'

test('mounts a renderer with its skin and forwards state', () => {
	const update = vi.fn()
	const destroy = vi.fn()
	const skin: AvatarSkin = { id: 'test-skin' }
	const renderer: AvatarRenderer<AvatarSkin> = {
		id: 'test-renderer',
		mount: vi.fn(() => ({ update, destroy }))
	}
	const host = { dataset: {} } as unknown as HTMLElement
	const avatar = { renderer, skin }
	const handle = mountAvatar(host, avatar, { expression: null })

	expect(renderer.mount).toHaveBeenCalledWith(host, skin, { expression: null })
	expect(host.dataset).toEqual({
		renderer: 'test-renderer',
		skin: 'test-skin',
		expression: 'resting'
	})

	handle.update({ expression: 'pleased' })
	expect(update).toHaveBeenCalledWith({ expression: 'pleased' })
	expect(host.dataset.expression).toBe('pleased')

	handle.destroy()
	expect(destroy).toHaveBeenCalledOnce()
	expect(host.dataset).toEqual({})
})

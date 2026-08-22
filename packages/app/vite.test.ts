import { type Plugin, resolveConfig, type ViteDevServer } from 'vite'
import { expect, test, vi } from 'vitest'
import { devAi, kernelHost } from './vite.ts'

test('devAi is a serve-only backend descriptor', () => {
	expect(devAi()).toMatchObject({
		name: 'kernel-host:ai',
		apply: 'serve',
		api: { backend: 'auto' }
	})
})

test('dev scans the GUI hidden behind the generated page', async () => {
	const config = await resolveConfig(
		{
			configFile: false,
			plugins: kernelHost({
				id: 'app.test',
				name: 'Test',
				app: 'src/app.ts',
				gui: 'src/gui.tsx'
			})
		},
		'serve'
	)

	expect(config.optimizeDeps.entries).toEqual(['src/gui.tsx'])
})

test('dev closes its host through the Vite lifecycle', async () => {
	const close = vi.fn()
	const middleware = Object.assign(vi.fn(), { close })
	const use = vi.fn()
	const plugin = (
		kernelHost({
			id: 'app.test',
			name: 'Test',
			app: 'src/app.ts',
			gui: 'src/gui.ts'
		}) as Plugin[]
	).find(({ name }) => name === 'kernel-host-dev')
	if (!plugin) throw new Error('missing kernel-host-dev plugin')
	const configure = plugin.configureServer as (server: ViteDevServer) => () => Promise<void>
	const after = configure({
		middlewares: { use },
		ssrLoadModule: async () => ({ createDevServer: async () => middleware })
	} as unknown as ViteDevServer)

	await after()
	expect(use).toHaveBeenCalledWith(middleware)
	await (plugin.closeBundle as () => Promise<void>)()
	expect(close).toHaveBeenCalledOnce()
})

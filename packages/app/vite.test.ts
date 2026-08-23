import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('watch builds emit the reducer and manifest again', async () => {
	const root = mkdtempSync(join(tmpdir(), 'kernel-host-watch-'))
	mkdirSync(join(root, 'src'))
	const app = join(root, 'src/app.ts')
	writeFileSync(app, 'export const app = { marker: 1, capabilities: {} }')
	const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
	const plugins = kernelHost({
		id: 'app.test',
		name: 'Test',
		app: 'src/app.ts',
		gui: 'src/gui.ts'
	}) as Plugin[]
	cwd.mockRestore()
	expect(plugins.some(({ name }) => name === 'kernel-host-local-store')).toBe(true)
	const plugin = plugins.find(({ name }) => name === 'kernel-host')
	if (!plugin) throw new Error('missing kernel-host plugin')
	const start = plugin.buildStart as () => void
	const close = plugin.closeBundle as () => Promise<void>

	try {
		start()
		await close()
		const first = readFileSync(join(root, 'dist/app.js'), 'utf8')
		writeFileSync(app, 'export const app = { marker: 2, capabilities: {} }')
		start()
		await close()
		expect(readFileSync(join(root, 'dist/app.js'), 'utf8')).not.toBe(first)
		expect(JSON.parse(readFileSync(join(root, 'dist/manifest.json'), 'utf8'))).toMatchObject({
			id: 'app.test',
			app: 'app.js'
		})
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

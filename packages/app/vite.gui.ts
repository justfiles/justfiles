import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
	build,
	loadConfigFromFile,
	mergeConfig,
	type Plugin,
	type PluginOption,
	type UserConfig,
	type ViteDevServer
} from 'vite'
import type { DevServerOptions } from './dev-server.ts'

export function guiBuild(id: string, entry: string, imports: Record<string, string>): UserConfig {
	return {
		base: './',
		define: { 'process.env.NODE_ENV': JSON.stringify('production') },
		build: {
			outDir: 'dist',
			emptyOutDir: true,
			lib: { entry, formats: ['es'], fileName: () => 'gui.js' },
			rollupOptions: {
				external: Object.keys(imports),
				output: { paths: imports, codeSplitting: false }
			}
		},
		plugins: [
			{
				name: 'kernel-host-css',
				apply: 'build',
				enforce: 'post',
				generateBundle(_, bundle) {
					let css = ''
					for (const [file, output] of Object.entries(bundle)) {
						if (output.type !== 'asset' || !file.endsWith('.css')) continue
						css +=
							typeof output.source === 'string'
								? output.source
								: new TextDecoder().decode(output.source)
						delete bundle[file]
					}
					const entry = Object.values(bundle).find((o) => o.type === 'chunk' && o.isEntry)
					if (!css || entry?.type !== 'chunk') return
					const selector = JSON.stringify(`style[data-app-style="${id}"]`)
					entry.code =
						`(function(){if(typeof document==="undefined"||document.querySelector(${selector}))return;` +
						`var s=document.createElement("style");s.setAttribute("data-app-style",${JSON.stringify(id)});` +
						`s.textContent=${JSON.stringify(css)};document.head.appendChild(s)})();\n${entry.code}`
				}
			} satisfies Plugin
		]
	}
}

export async function watchGui(
	server: ViteDevServer,
	opts: DevServerOptions
): Promise<() => Promise<void>> {
	const root = server.config.root

	let bundle: { version: number; code?: string; error?: string } = { version: 0 }
	let candidate: string | undefined
	const publish = (next: { code?: string; error?: string }) => {
		bundle = { code: bundle.code, ...next, version: bundle.version + 1 }
		server.hot.send({ type: 'custom', event: 'kernel-host:gui', data: bundle })
	}
	server.middlewares.use('/_kernel-host/gui', (_req, res) => {
		res.setHeader('Content-Type', 'application/json')
		res.setHeader('Cache-Control', 'no-store')
		res.end(JSON.stringify(bundle))
	})
	// Vite inherits NODE_ENV from its parent dev server even for a production build.
	// Resolve build plugins before the headless host starts, then restore its environment.
	const previous = process.env.NODE_ENV
	process.env.NODE_ENV = 'production'
	try {
		const loaded = server.config.configFile
			? await loadConfigFromFile(
					{ command: 'build', mode: 'production' },
					server.config.configFile,
					root
				)
			: null
		const config = mergeConfig(loaded?.config ?? {}, server.config.inlineConfig)
		config.plugins = await withoutHost(config.plugins ?? [])
		const outDir = await mkdtemp(resolve(tmpdir(), 'justfiles-gui-'))
		const watcher = await build(
			mergeConfig(
				mergeConfig(config, guiBuild(opts.id, resolve(root, opts.gui), opts.imports ?? {})),
				{
					configFile: false,
					root,
					mode: 'production',
					logLevel: 'warn',
					build: {
						outDir,
						copyPublicDir: false,
						watch: { exclude: ['**/.justfiles/**', '**/dist/**'] }
					},
					plugins: [
						{
							name: 'kernel-host-gui-result',
							enforce: 'post',
							generateBundle: {
								order: 'post',
								handler(_options, output) {
									const chunks = Object.values(output).filter((part) => part.type === 'chunk')
									if (chunks.length !== 1) throw new Error('Expected one GUI bundle')
									candidate = chunks[0]!.code
								}
							}
						} satisfies Plugin
					]
				}
			)
		)
		if (!('on' in watcher)) throw new Error('GUI build did not start a watcher')
		watcher.on('event', (event) => {
			if (event.code === 'ERROR') publish({ error: event.error.message })
			if (event.code === 'BUNDLE_END') {
				publish({ code: candidate })
			}
		})
		return async () => {
			await watcher.close()
			await rm(outDir, { recursive: true, force: true })
		}
	} finally {
		if (previous === undefined) delete process.env.NODE_ENV
		else process.env.NODE_ENV = previous
	}
}

async function withoutHost(options: PluginOption[]): Promise<PluginOption[]> {
	const plugins: PluginOption[] = []
	for (const option of options) {
		const plugin = await option
		if (Array.isArray(plugin)) plugins.push(...(await withoutHost(plugin)))
		else if (plugin && !plugin.name.startsWith('kernel-host')) plugins.push(plugin)
	}
	return plugins
}

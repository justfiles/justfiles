import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import type { Plugin } from 'vite'
import type { AppManifest } from './app'
import type { createHost, HostOptions } from './host'

// `kernelHost` is the app package's only build wiring. It has two modes:
//
//   serve  — local dev only. Boots an in-memory kernel that emulates the
//            real host (frieren), via ./host loaded through vite's pipeline.
//   build  — emits the production artifact: Vite builds the browser
//            `gui.js`; closeBundle emits the headless `app.js` + manifest.
//            The app never runs on its own — a kernel host (frieren, on
//            Cloudflare Workers) installs this artifact and serves it.
//
// Only bare specifiers + type-only imports here: the config loader
// externalizes this plugin and resolves it with native Node, which can't
// load relative TypeScript siblings (hence ./host goes via ssrLoadModule).
const compile = (entry: string) =>
	buildSync({
		entryPoints: [entry],
		absWorkingDir: dirname(entry),
		bundle: true,
		write: false,
		format: 'esm',
		minify: true
	}).outputFiles[0].text

export function kernelHost(opts: HostOptions): Plugin {
	const root = process.cwd()
	let emitted = false
	return {
		name: 'kernel-host',
		config(_, env) {
			if (env.command === 'serve') return { appType: 'custom' }
			return {
				base: './',
				build: {
					outDir: 'dist',
					emptyOutDir: true,
					// Library mode: preserve the entry's `export { gui }` (an app
					// build tree-shakes it away — the sdk is sideEffects:false).
					lib: {
						entry: resolve(root, opts.gui),
						formats: ['es'],
						fileName: () => 'gui.js'
					}
				}
			}
		},
		configureServer(server) {
			return async () => {
				const host = (await server.ssrLoadModule('@justfiles/app/kernel/host')) as {
					createHost: typeof createHost
				}
				server.middlewares.use(await host.createHost(server.config.root, opts))
			}
		},
		closeBundle() {
			if (emitted) return
			emitted = true
			const out = resolve(root, 'dist')
			mkdirSync(out, { recursive: true })
			writeFileSync(resolve(out, 'app.js'), compile(resolve(root, opts.app)))
			const manifest: AppManifest = { id: opts.id, name: opts.name, app: 'app.js', gui: 'gui.js' }
			writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, '\t'))
		}
	}
}

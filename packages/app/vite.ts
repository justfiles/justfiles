import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import type { Plugin } from 'vite'
import type { AppManifest } from './app.ts'
import type { createDevServer, DevServerOptions } from './dev-server.ts'

// `kernelHost` is the app package's only build wiring. It has two modes:
//
//   serve  — local dev only. Boots an in-memory kernel that emulates the
//            real host (frieren), via ./dev-server loaded through vite.
//   build  — emits the production artifact: Vite builds the browser
//            `gui.js`; closeBundle emits the headless `app.js` + manifest.
//            The app never runs on its own — a kernel host (frieren, on
//            Cloudflare Workers) installs this artifact and serves it.
//
// Only bare specifiers + type-only imports here: the config loader
// externalizes this plugin and resolves it with native Node, which can't
// load relative TypeScript siblings (./dev-server goes via ssrLoadModule).
const compile = (entry: string) => {
	const output = buildSync({
		entryPoints: [entry],
		absWorkingDir: dirname(entry),
		bundle: true,
		write: false,
		format: 'esm',
		minify: true
	}).outputFiles[0]
	if (!output) throw new Error(`failed to compile ${entry}`)
	return output.text
}

export function kernelHost(opts: DevServerOptions): Plugin {
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
					},
					rollupOptions: {
						// The host serves a single shared React via /vendor/*.js
						// (see apps/frieren importmap). Apps emit bare specifiers
						// and the browser resolves them through the importmap —
						// one URL, one React instance across host and every app.
						external: [
							'react',
							'react-dom',
							'react-dom/client',
							'react/jsx-runtime',
							'react/jsx-dev-runtime'
						]
					}
				}
			}
		},
		configureServer(server) {
			return async () => {
				const mod = (await server.ssrLoadModule('@justfiles/app/dev-server')) as {
					createDevServer: typeof createDevServer
				}
				server.middlewares.use(await mod.createDevServer(server.config.root, opts))
			}
		},
		closeBundle() {
			if (emitted) return
			emitted = true
			const out = resolve(root, 'dist')
			mkdirSync(out, { recursive: true })
			writeFileSync(resolve(out, 'app.js'), compile(resolve(root, opts.app)))
			const manifest: AppManifest = {
				id: opts.id,
				name: opts.name,
				description: opts.description,
				version: opts.version,
				icon: opts.icon,
				app: 'app.js',
				gui: 'gui.js'
			}
			writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, '\t'))
		}
	}
}

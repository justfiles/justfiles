import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { isReactGuiEntry, reactGuiEntry } from '@justfiles/app/react-entry'
import { externals, reactExternals, sentinelizeReducer } from '@justfiles/app/sdk-externals'
import tailwindcss from '@tailwindcss/vite'
import { buildSync } from 'esbuild'
import type { PluginOption } from 'vite'
import { createRunnableDevEnvironment } from 'vite'
import type { AppManifest } from './app.ts'
import type { createDevServer, DevServerOptions } from './dev-server.ts'

const DEV_STYLE_URL = '/_kernel-host/dev-style.js'
const DEV_STYLE_ID = '\0kernel-host:dev-style'
const DEV_STYLE_CSS = `/@fs/${new URL('./dev-server.css', import.meta.url).pathname}`
const DEV_BOOTSTRAP_URL = '/_kernel-host/bootstrap.js'
const DEV_BOOTSTRAP_ID = '\0kernel-host:bootstrap'
const VIRTUAL_GUI_ID = 'virtual:justfiles-app/gui'
const RESOLVED_VIRTUAL_GUI_ID = `\0${VIRTUAL_GUI_ID}`

// `kernelHost` is the app package's only build wiring. It has two modes:
//
//   serve  — local dev only. Boots an in-memory kernel that emulates the
//            real host (frieren), via ./dev-server loaded through vite.
//   build  — emits the production artifact: Vite builds the browser `gui.js`;
//            closeBundle emits the headless `app.js` and manifest. Hosts seed
//            built-ins by reading the emitted files directly.
//
// Only bare specifiers + type-only imports here: the config loader
// externalizes this plugin and resolves it with native Node, which can't
// load relative TypeScript siblings (./dev-server goes via ssrLoadModule, the
// React shim codegen via the bare @justfiles/app/react-entry specifier).
// Compile the reducer (`app.js`). The SDK + React are externalized (not bundled): the host
// owns the SDK runtime, so the reducer links it at launch, not a copy frozen at build. A
// reducer Worker has no importmap, so its bare SDK imports are rewritten to the
// `justfiles-sdk:` sentinel the host resolves at spawn (`sentinelizeReducer`).
const compile = (entry: string) => {
	const output = buildSync({
		entryPoints: [entry],
		absWorkingDir: dirname(entry),
		bundle: true,
		write: false,
		format: 'esm',
		minify: true,
		external: externals
	}).outputFiles[0]
	if (!output) throw new Error(`failed to compile ${entry}`)
	return sentinelizeReducer(output.text)
}

function readPackageVersion(root: string): string | undefined {
	try {
		const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
			version?: string
		}
		return pkg.version
	} catch {
		return undefined
	}
}

function reactDevGuiEntry(specifier: string): string {
	return `import * as mod from ${JSON.stringify(specifier)}
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { defineGUI } from '@justfiles/app/browser'

const componentMode = !mod.gui
const hotState = import.meta.hot?.data.reactGui ?? { current: mod, instances: new Set() }
hotState.current = mod
if (import.meta.hot) import.meta.hot.data.reactGui = hotState

function HotComponent(props) {
	const Component = hotState.current.default
	return Component(props)
}

const componentSpec = {
	mount(el, state, ctx) {
		const root = createRoot(el)
		const instance = {
			state,
			update(next) {
				instance.state = next
				root.render(createElement(HotComponent, { state: next, actions: ctx.client }))
			},
			unmount() {
				hotState.instances.delete(instance)
				root.unmount()
			}
		}
		hotState.instances.add(instance)
		instance.update(state)
		return instance
	}
}
if (mod.menu) componentSpec.menu = (state, client) => hotState.current.menu?.(state, client) ?? []
const componentGui = defineGUI(componentSpec)

export const gui = mod.gui ?? componentGui
export const __hmr = { preserve: componentMode && !!mod.default }

function replace(next) {
	hotState.current = next
	for (const instance of hotState.instances) instance.update(instance.state)
}

if (__hmr.preserve) replace(mod)

if (import.meta.hot && __hmr.preserve) {
	import.meta.hot.accept(${JSON.stringify(specifier)}, (next) => {
		if (!next || next.gui || !next.default) {
			import.meta.hot.invalidate('GUI module shape changed')
			return
		}
		replace(next)
	})
}
`
}

function devBootstrapEntry(): string {
	return `import { gui as initialGui } from ${JSON.stringify(VIRTUAL_GUI_ID)}

const root = document.getElementById('app')
if (!root) throw new Error('missing app root')
let latestState = await fetch('/_state').then((r) => r.json())
const transport = {
	invoke: (action) =>
		fetch('/_dispatch', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(action)
		}).then(async (r) => {
			if (!r.ok) throw new Error(await r.text())
			return r.json()
		}),
	subscribe: (onState) => {
		const es = new EventSource('/_subscribe')
		es.onmessage = (e) => {
			latestState = JSON.parse(e.data)
			onState(latestState)
		}
		return () => es.close()
	}
}
let instance = initialGui.mount(root, latestState, { transport })

if (import.meta.hot) {
	import.meta.hot.accept(${JSON.stringify(VIRTUAL_GUI_ID)}, async (next) => {
		if (!next?.gui || next.__hmr?.preserve) return
		await instance.unmount()
		instance = next.gui.mount(root, latestState, { transport })
	})
	import.meta.hot.dispose(() => {
		void instance.unmount()
	})
}
`
}

export function kernelHost(opts: DevServerOptions): PluginOption[] {
	const root = process.cwd()
	const appEntry = resolve(root, opts.app)
	const guiEntry = resolve(root, opts.gui)
	const wrapReactGui = isReactGuiEntry(guiEntry)
	const reactGuiEntryPath = resolve(root, 'node_modules/.cache/justfiles-app/react-gui-entry.js')
	let emitted = false
	return [
		...tailwindcss(),
		{
			name: 'kernel-host',
			config(_, env) {
				if (env.command === 'serve') {
					// The headless reducer runs in its own `kernel` server
					// environment (Vite Environment API): a RunnableDevEnvironment
					// with a module graph distinct from the browser `client` one.
					// dev-server loads src/app.ts via environments.kernel.runner.
					return {
						appType: 'custom',
						resolve: { dedupe: reactExternals },
						environments: {
							kernel: {
								consumer: 'server',
								// Custom envs aren't runnable by default — supply the factory.
								dev: {
									createEnvironment: (name, config) => createRunnableDevEnvironment(name, config)
								}
							}
						}
					}
				}
				if (wrapReactGui) {
					mkdirSync(dirname(reactGuiEntryPath), { recursive: true })
					writeFileSync(reactGuiEntryPath, reactGuiEntry(guiEntry))
				}
				return {
					base: './',
					build: {
						outDir: 'dist',
						emptyOutDir: true,
						// Library mode: preserve the entry's `export { gui }` (an app
						// build tree-shakes it away — the sdk is sideEffects:false).
						lib: {
							entry: wrapReactGui ? reactGuiEntryPath : guiEntry,
							formats: ['es'],
							fileName: () => 'gui.js'
						},
						rollupOptions: {
							// The host serves a single shared React + the SDK via /vendor/*.js
							// (see the importmap). The gui emits bare specifiers and the browser
							// resolves them through the importmap — one URL per library across the
							// host and every app, and the app links the host's SDK at runtime.
							external: externals
						}
					}
				}
			},
			resolveId(id) {
				if (id === DEV_STYLE_URL) return DEV_STYLE_ID
				if (id === DEV_BOOTSTRAP_URL) return DEV_BOOTSTRAP_ID
				if (id === VIRTUAL_GUI_ID) return RESOLVED_VIRTUAL_GUI_ID
				return null
			},
			load(id) {
				if (id === DEV_STYLE_ID) return `import ${JSON.stringify(DEV_STYLE_CSS)}`
				if (id === DEV_BOOTSTRAP_ID) return devBootstrapEntry()
				if (id === RESOLVED_VIRTUAL_GUI_ID) {
					const guiSpecifier = `/${relative(root, guiEntry).split('\\').join('/')}`
					return wrapReactGui
						? reactDevGuiEntry(guiSpecifier)
						: `export { gui } from ${JSON.stringify(guiSpecifier)}\n`
				}
				return null
			},
			configureServer(server) {
				return async () => {
					const mod = (await server.ssrLoadModule('@justfiles/app/dev-server')) as {
						createDevServer: typeof createDevServer
					}
					server.middlewares.use(await mod.createDevServer(server, opts))
				}
			},
			closeBundle() {
				if (emitted) return
				emitted = true
				const out = resolve(root, 'dist')
				mkdirSync(out, { recursive: true })
				writeFileSync(resolve(out, 'app.js'), compile(appEntry))
				const manifest: AppManifest = {
					id: opts.id,
					name: opts.name,
					description: opts.description,
					// Fall back to package.json#version so apps don't have to thread it
					// through the kernelHost() call by hand. Explicit opts.version wins.
					version: opts.version ?? readPackageVersion(root),
					icon: opts.icon,
					include: opts.include,
					app: 'app.js',
					gui: 'gui.js'
				}
				writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, '\t'))
			}
		}
	]
}

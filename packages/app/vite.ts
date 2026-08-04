import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isReactGuiEntry, reactGuiEntry } from '@justfiles/app/react-entry'
import { reactSpecs } from '@justfiles/app/runtime-specs'
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
// load relative TypeScript siblings (./dev-server goes via ssrLoadModule;
// React shim codegen/runtime specs use bare @justfiles/app/* specifiers).
// Compile the reducer (`app.js`). Everything it references is inlined — nothing is
// external — because a reducer Worker resolves no bare specifiers at runtime.
//
// A reducer must not reach React: it runs headless, with no document. That used to fail
// loudly (a bare `react` import had nothing to resolve it); now that nothing is external
// it would ship React into the Worker silently and break only later, so read the input
// graph back off the metafile and refuse the build instead.
const REACT_INPUT = /(^|\/)node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?react(-dom)?\//
const compile = (entry: string) => {
	const result = buildSync({
		entryPoints: [entry],
		absWorkingDir: dirname(entry),
		bundle: true,
		write: false,
		format: 'esm',
		minify: true,
		metafile: true
	})
	const react = Object.keys(result.metafile.inputs).find((input) => REACT_INPUT.test(input))
	if (react)
		throw new Error(
			`${entry} pulls React in through the module graph (${react}). The reducer runs ` +
				`headless in a Worker with no document — keep React in the GUI entry.`
		)
	const output = result.outputFiles[0]
	if (!output) throw new Error(`failed to compile ${entry}`)
	return output.text
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

// Read the app's declared capabilities from the freshly built reducer bundle by
// importing it (headless, no DOM) and reading `app.capabilities`. Emitted into the
// manifest as static metadata (AppManifest.capabilities) so the store can show
// them and gate escalation WITHOUT running the app. Best-effort: any failure just
// omits the field.
async function readManifestCapabilities(
	appJsPath: string
): Promise<Record<string, { id: string; scopes: string[] }> | undefined> {
	try {
		const mod = (await import(`${pathToFileURL(appJsPath).href}?t=${Date.now()}`)) as {
			app?: { capabilities?: Record<string, { id: string; scopes: readonly string[] }> }
		}
		const caps = mod.app?.capabilities
		if (!caps || typeof caps !== 'object') return undefined
		const out: Record<string, { id: string; scopes: string[] }> = {}
		for (const [name, value] of Object.entries(caps))
			out[name] = { id: value.id, scopes: [...(value.scopes ?? [])] }
		return Object.keys(out).length ? out : undefined
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
						resolve: { dedupe: reactSpecs },
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
					// The framework now ships INSIDE the artifact, so the artifact decides
					// which build of it ships. React (and much of npm) picks its dev/prod
					// branch off `process.env.NODE_ENV` at require time, and a dev React is
					// ~3× the bytes for warnings no end user reads. Apps used to get the
					// production build for free from the host's vendored copy.
					define: { 'process.env.NODE_ENV': JSON.stringify('production') },
					// ONE React per artifact. The SDK's React GUI shim and the app's own
					// components both import `react`, and pnpm can resolve those to two
					// different copies (a workspace on 19.2.5, another on 19.2.7 — a real
					// state of this repo). Two Reacts in one bundle means the renderer sets
					// the hook dispatcher on an instance the components never read, and every
					// GUI dies on its first `useState`. Externalisation used to hide this by
					// collapsing both to one host module; now the build must collapse them.
					resolve: { dedupe: reactSpecs },
					build: {
						outDir: 'dist',
						emptyOutDir: true,
						// Library mode: preserve the entry's `export { gui }` (an app
						// build tree-shakes it away — the sdk is sideEffects:false).
						// Nothing is external: the SDK and whatever framework the GUI uses are
						// both inlined into gui.js, matching app.js. Hosts serve no framework
						// bytes, so an app that ships Svelte or plain DOM pays only for itself.
						lib: {
							entry: wrapReactGui ? reactGuiEntryPath : guiEntry,
							formats: ['es'],
							fileName: () => 'gui.js'
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
			async closeBundle() {
				if (emitted) return
				emitted = true
				const out = resolve(root, 'dist')
				mkdirSync(out, { recursive: true })
				const appJs = resolve(out, 'app.js')
				writeFileSync(appJs, compile(appEntry))
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
					gui: 'gui.js',
					capabilities: await readManifestCapabilities(appJs)
				}
				writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, '\t'))
			}
		},
		{
			// `import './x.css'` in a GUI is extracted by the lib build into a side
			// asset the host never links. Fold every CSS asset back into gui.js as a
			// runtime <style> so the bundle stays self-contained (browser.ts) and the
			// authored import reads like any web project. Build-only — `vite dev`
			// injects CSS itself.
			name: 'kernel-host-css',
			apply: 'build',
			enforce: 'post',
			generateBundle(_, bundle) {
				let css = ''
				for (const [file, output] of Object.entries(bundle)) {
					if (output.type === 'asset' && file.endsWith('.css')) {
						css +=
							typeof output.source === 'string'
								? output.source
								: new TextDecoder().decode(output.source)
						delete bundle[file]
					}
				}
				if (!css) return
				const entry = Object.values(bundle).find((o) => o.type === 'chunk' && o.isEntry)
				if (entry?.type !== 'chunk') return
				const selector = JSON.stringify(`style[data-app-style="${opts.id}"]`)
				entry.code =
					`(function(){if(typeof document==="undefined"||document.querySelector(${selector}))return;` +
					`var s=document.createElement("style");s.setAttribute("data-app-style",${JSON.stringify(opts.id)});` +
					`s.textContent=${JSON.stringify(css)};document.head.appendChild(s)})();\n${entry.code}`
			}
		}
	]
}

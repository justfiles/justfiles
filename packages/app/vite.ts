import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin, PluginOption } from 'vite'
import { build, createRunnableDevEnvironment } from 'vite'
import type { AppManifest } from './app.ts'
import type { AiBackend } from './capabilities/ai/dev.ts'
import { validateImportMap } from './capabilities/devkit/imports.ts'
import type { createDevServer, DevServerOptions } from './dev-server.ts'
import { guiBuild, watchGui } from './vite.gui.ts'
import { localStore } from './vite.local-store.ts'

export type { AiBackend, GenerateText } from './capabilities/ai/dev.ts'

const DEV_STYLE_URL = '/_kernel-host/dev-style.js'
const DEV_STYLE_ID = '\0kernel-host:dev-style'
const DEV_STYLE_CSS = `/@fs/${new URL('./dev-server.css', import.meta.url).pathname}`
const DEV_BOOTSTRAP_URL = '/_kernel-host/bootstrap.js'
const DEV_BOOTSTRAP_ID = '\0kernel-host:bootstrap'

export function devAi(backend: AiBackend = 'auto'): Plugin {
	return { name: 'kernel-host:ai', apply: 'serve', api: { backend } }
}

// Compile the reducer (`app.js`) with Vite itself, so this plugin carries no bundler
// of its own — the app already has Vite, and Vite ships no esbuild. `configFile: false`
// keeps the nested build from re-entering the app's config and this plugin. Everything
// it references is inlined — nothing is external — because a reducer Worker resolves no
// bare specifiers at runtime.
const compile = async (entry: string): Promise<string> => {
	const result = await build({
		configFile: false,
		logLevel: 'warn',
		build: {
			write: false,
			minify: true,
			// Match what esbuild emitted before: untranspiled modern output. The reducer
			// runs in a Worker and is imported by Node to read its capabilities.
			target: 'esnext',
			lib: { entry, formats: ['es'], fileName: () => 'app.js' },
			rollupOptions: { output: { codeSplitting: false } }
		}
	})
	const outputs = Array.isArray(result) ? result : [result]
	const chunks = outputs
		.flatMap((out) => ('output' in out ? out.output : []))
		.filter((part) => part.type === 'chunk')
	// `codeSplitting: false` has to collapse everything into one chunk, because only
	// the entry is written to disk. A second chunk would mean `app.js` ships an
	// `import()` pointing at a file that was never emitted — a reducer that builds
	// clean and dies at runtime. Fail the build instead.
	if (chunks.length !== 1) {
		const names = chunks.map((part) => part.fileName).join(', ')
		throw new Error(`${entry}: expected one chunk, got ${chunks.length} (${names})`)
	}
	const chunk = chunks[0]
	if (chunk?.type !== 'chunk') throw new Error(`failed to compile ${entry}`)
	return chunk.code
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

export function kernelHost(opts: DevServerOptions): PluginOption[] {
	const root = process.cwd()
	const imports = validateImportMap(opts.imports, 'kernelHost()')
	const appEntry = resolve(root, opts.app)
	const guiEntry = resolve(root, opts.gui)
	const { plugins: guiPlugins, ...guiConfig } = guiBuild(opts.id, guiEntry, imports)

	let emitted = false
	let production = true
	let closeGui: (() => Promise<void>) | undefined
	let closeDevServer: (() => Promise<void>) | undefined
	return [
		{
			name: 'kernel-host',
			buildStart() {
				emitted = false
			},
			configResolved(config) {
				production = config.command === 'build'
			},
			config(_, env) {
				if (env.command === 'serve') {
					// The headless reducer runs in its own `kernel` server
					// environment (Vite Environment API): a RunnableDevEnvironment
					// with a module graph distinct from the browser `client` one.
					// dev-server loads src/app.ts via environments.kernel.runner.
					return {
						appType: 'custom',
						server: {
							watch: { ignored: ['**/.justfiles/dev/**'] },
							fs: {
								// Supplying deny replaces Vite's defaults; retain them alongside app data.
								deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.justfiles/dev/**']
							}
						},
						optimizeDeps: { entries: [] },
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
				return guiConfig
			},
			resolveId(id) {
				if (id === DEV_STYLE_URL) return DEV_STYLE_ID
				if (id === DEV_BOOTSTRAP_URL) return DEV_BOOTSTRAP_ID
				return null
			},
			load(id) {
				if (id === DEV_STYLE_ID) return `import ${JSON.stringify(DEV_STYLE_CSS)}`
				if (id === DEV_BOOTSTRAP_ID) {
					const file = new URL(
						import.meta.url.endsWith('.ts') ? './dev-frame.ts' : './dev-frame.js',
						import.meta.url
					)
					return `import ${JSON.stringify(`/@fs/${file.pathname}`)}`
				}
				return null
			},
			async closeBundle() {
				if (!production || emitted) return
				emitted = true
				const out = resolve(root, 'dist')
				mkdirSync(out, { recursive: true })
				const appJs = resolve(out, 'app.js')
				writeFileSync(appJs, await compile(appEntry))
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
			name: 'kernel-host-dev',
			apply: 'serve',
			async configureServer(server) {
				closeGui = await watchGui(server, opts)
				try {
					const mod = (await server.ssrLoadModule('@justfiles/app/dev-server')) as {
						createDevServer: typeof createDevServer
					}
					const middleware = await mod.createDevServer(server, opts)
					closeDevServer = middleware.close
					return () => {
						server.middlewares.use(middleware)
					}
				} catch (error) {
					await closeGui()
					closeGui = undefined
					throw error
				}
			},
			async closeBundle() {
				const close = closeDevServer
				closeDevServer = undefined
				await closeGui?.()
				closeGui = undefined
				await close?.()
			}
		},
		...(guiPlugins ?? []),
		localStore()
	]
}

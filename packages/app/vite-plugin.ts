// Vite plugins for the @justfiles/app format.
//
// `appBuilder()` — used by app authors. Declares two build environments
// (client iframe + backend ESM), bakes the package name into `defineApp`'s
// `__JUSTFILES_PKG__` constant, and emits `dist/manifest.json` after the
// backend env builds (by importing the just-written `app.js` and reading its
// default-exported metadata).
//
// `hostApps()` — used by hosts that aggregate multiple app packages. Reads
// each registered package's `package.json#main` to find its content root,
// validates via `loadAppPackage`, and exposes the result as a single virtual
// module `'virtual:@justfiles/apps'` that the host imports.
//
// Modeled on @cloudflare/vite-plugin: declarative environments + default
// series builder. Authors compose `appBuilder()` with framework plugins
// (e.g. @vitejs/plugin-react) — these plugins only own the format wiring.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin, UserConfig } from 'vite'
import { FORMAT_VERSION, type Manifest } from './format.js'
import { type AppEntry, loadAppPackage } from './host.js'

// ── appBuilder ─────────────────────────────────────────────────────────────

export interface AppBuilderOptions {
	/** Source dir relative to package root. Defaults to `src`. */
	srcDir?: string
	/** Backend entry, relative to `srcDir`. Defaults to `app.ts`. */
	appEntry?: string
	/** HTML entry, relative to `srcDir`. Defaults to `index.html`. */
	htmlEntry?: string
	/** Output dir relative to package root. Defaults to `dist`. */
	outDir?: string
	/** Modules kept external in the backend bundle. Defaults to typebox. */
	external?: string[]
}

export function appBuilder(opts: AppBuilderOptions = {}): Plugin {
	const srcDir = opts.srcDir ?? 'src'
	const appEntry = opts.appEntry ?? 'app.ts'
	const htmlEntry = opts.htmlEntry ?? 'index.html'
	const outDir = opts.outDir ?? 'dist'
	const external = opts.external ?? ['typebox', 'typebox/value']

	const pkgRoot = process.cwd()
	const pkgJson = readJson<{ name?: string; version?: string }>(
		path.resolve(pkgRoot, 'package.json')
	)
	const pkgName = pkgJson.name ?? ''
	const pkgVersion = pkgJson.version ?? '0.0.0'
	const absOut = path.resolve(pkgRoot, outDir)
	const backendName = 'app.js'
	const entryName = 'index.html'

	return {
		name: '@justfiles/app:builder',
		config(): UserConfig {
			return {
				root: path.resolve(pkgRoot, srcDir),
				// Relative asset URLs so the dist works under any mount path
				// (Frieren serves apps under /apps/<id>/, dev harness from /).
				base: './',
				// Bake the package name into `defineApp` so the runtime app
				// object carries `__pkg`. `JSON.stringify` produces a valid JS
				// string literal for Vite's `define` substitution.
				define: { __JUSTFILES_PKG__: JSON.stringify(pkgName) },
				environments: {
					client: {
						build: {
							outDir: absOut,
							rollupOptions: {
								input: htmlEntry,
								output: {
									entryFileNames: '[name].js',
									chunkFileNames: '[name].js',
									assetFileNames: '[name][extname]'
								}
							}
						}
					},
					app: {
						consumer: 'server',
						build: {
							outDir: absOut,
							emptyOutDir: false,
							rollupOptions: {
								input: appEntry,
								output: { entryFileNames: backendName, format: 'es' },
								external
							}
						}
					}
				}
			}
		},
		// Emit manifest.json once the backend env has flushed `app.js` to disk.
		// Loading the file picks up the same default export the host will see.
		applyToEnvironment(env) {
			return env.name === 'app'
		},
		async closeBundle() {
			const backendPath = path.join(absOut, backendName)
			if (!fs.existsSync(backendPath)) return
			// Cache-busting query so subsequent builds see the latest module.
			const url = `${pathToFileURL(backendPath).href}?t=${Date.now()}`
			const mod: { default?: { name?: string; description?: string; icon?: string } } =
				await import(url)
			const app = mod.default
			if (!app || typeof app.name !== 'string') {
				throw new Error(
					`appBuilder: ${backendName} must default-export an App with a string \`name\``
				)
			}
			const icon = normalizeFlatAssetPath(app.icon)
			if (icon) {
				const source = path.resolve(pkgRoot, srcDir, icon)
				const dest = path.join(absOut, icon)
				if (!fs.existsSync(source) && !fs.existsSync(dest)) {
					throw new Error(`appBuilder: icon "${icon}" not found in ${srcDir}/ or ${outDir}/`)
				}
				if (fs.existsSync(source)) fs.copyFileSync(source, dest)
			}
			const manifest: Manifest = {
				format: FORMAT_VERSION,
				name: app.name,
				description: app.description ?? '',
				version: pkgVersion,
				icon,
				entry: entryName,
				backend: backendName
			}
			fs.writeFileSync(path.join(absOut, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
		}
	}
}

// ── hostApps ──────────────────────────────────────────────────────────────

/** Reference to an app package: either a bare name, or an imported app
 * object that carries `__pkg` (added by `appBuilder()`). */
export type AppRef = string | { __pkg?: string }

/** Either a list (id derived from package name) or an explicit id→ref map. */
export type HostAppsArg = AppRef[] | Record<string, AppRef>

const VIRTUAL_ID = 'virtual:@justfiles/apps'
const RESOLVED_ID = `\0${VIRTUAL_ID}`

export function hostApps(arg: HostAppsArg): Plugin {
	return {
		name: '@justfiles/app:host',
		resolveId(id) {
			if (id === VIRTUAL_ID) return RESOLVED_ID
			return undefined
		},
		load(id) {
			if (id !== RESOLVED_ID) return undefined
			// Resolve from the consuming project's root, not from the plugin's
			// own node_modules location. The plugin lives in `@justfiles/app`,
			// which won't have the host's app dependencies hoisted nearby.
			const require = createRequire(path.join(process.cwd(), 'package.json'))
			const pairs = Array.isArray(arg)
				? arg.map((ref) => [null, ref] as const)
				: Object.entries(arg).map(([k, ref]) => [k, ref] as const)

			const seen = new Set<string>()
			const entries: Array<[string, AppEntry]> = []
			for (const [explicitId, ref] of pairs) {
				const pkgName = typeof ref === 'string' ? ref : ref.__pkg
				if (!pkgName) {
					throw new Error(
						"hostApps: ref is missing `__pkg`. Pass a package-name string, or import a package built with `appBuilder()` (which injects __pkg via Vite's `define`)."
					)
				}
				const id = explicitId ?? deriveId(pkgName)
				if (seen.has(id)) {
					throw new Error(
						`hostApps: duplicate id "${id}" — use the object form ({ "${id}": ref, "${id}-alt": otherRef }) to disambiguate.`
					)
				}
				seen.add(id)
				entries.push([id, loadFromInstalledPackage(require, pkgName)])
			}

			// JSON is a subset of JS expression syntax, so the stringified
			// entries inline directly into the generated module body.
			return `export const registry = new Map(${JSON.stringify(entries)})\n`
		}
	}
}

function loadFromInstalledPackage(
	require: ReturnType<typeof createRequire>,
	pkgName: string
): AppEntry {
	let mainPath: string
	try {
		mainPath = require.resolve(pkgName)
	} catch (e) {
		throw new Error(
			`hostApps: cannot resolve package "${pkgName}". Is it installed and built (\`vite build --app\`)? Underlying: ${String(e)}`
		)
	}
	const contentDir = path.dirname(mainPath)
	const files: Record<string, string> = {}
	for (const name of fs.readdirSync(contentDir)) {
		const full = path.join(contentDir, name)
		if (!fs.statSync(full).isFile()) continue
		// TODO(binary-assets): widen this when FileBag accepts Uint8Array.
		// For now, every file is read as utf-8 text. Will need MIME-aware
		// branching once images/fonts ship inside packages.
		files[name] = fs.readFileSync(full, 'utf8')
	}
	return loadAppPackage(files)
}

function deriveId(pkgName: string): string {
	const tail = pkgName.includes('/') ? (pkgName.split('/').pop() ?? pkgName) : pkgName
	return tail.replace(/^app-/, '')
}

function normalizeFlatAssetPath(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length === 0) return undefined
	if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
		throw new Error(`appBuilder: icon must be a flat app asset filename, got "${value}"`)
	}
	return value
}

function readJson<T>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

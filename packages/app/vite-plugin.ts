// Vite plugins for the @justfiles/app format.
//
// `appBuilder()` — used by app authors. A thin wrapper over the standard
// Vite client build. Treats `<pkgRoot>/public/` as Vite's `publicDir` so
// binary assets (wasm, wad, fonts) flow through to `dist/` verbatim, and
// emits relative asset URLs so the dist works under any mount path
// (Frieren serves apps under `/apps/<id>/`, dev harness from `/`).
//
// `hostApps()` — used by hosts that aggregate multiple app packages. Reads
// each registered package's `package.json#main` to find its content root,
// validates the manifest, and:
//   1. exposes `{id, manifest}` via the virtual module
//      `'virtual:@justfiles/apps'` — small data the worker bundles;
//   2. emits every other file under `dist/apps/<id>/<path>` into the host's
//      build output, so the bytes ship via Workers Static Assets and the
//      worker streams them through its ASSETS binding.
// In dev, a Vite middleware mirrors step 2 by serving `/apps/<id>/*` from
// each package's installed dist directory.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Plugin, UserConfig } from 'vite'
import { FORMAT_VERSION, type Manifest } from './format.js'

// ── appBuilder ─────────────────────────────────────────────────────────────

export interface AppBuilderOptions {
	/** Source dir relative to package root. Defaults to `src`. */
	srcDir?: string
	/** HTML entry, relative to `srcDir`. Defaults to `index.html`. */
	htmlEntry?: string
	/** Output dir relative to package root. Defaults to `dist`. */
	outDir?: string
	/** Public dir relative to package root. Defaults to `public`. */
	publicDir?: string
}

export function appBuilder(opts: AppBuilderOptions = {}): Plugin {
	const srcDir = opts.srcDir ?? 'src'
	const htmlEntry = opts.htmlEntry ?? 'index.html'
	const outDir = opts.outDir ?? 'dist'
	const publicDir = opts.publicDir ?? 'public'

	const pkgRoot = process.cwd()
	const absOut = path.resolve(pkgRoot, outDir)
	const absPublic = path.resolve(pkgRoot, publicDir)

	return {
		name: '@justfiles/app:builder',
		config(): UserConfig {
			return {
				root: path.resolve(pkgRoot, srcDir),
				// `publicDir` resolves relative to `root`; absolute path
				// pins it at package root so authors don't have to nest
				// binary assets under `src/`.
				publicDir: absPublic,
				// Relative asset URLs so the dist works under any mount path
				// (Frieren serves apps under /apps/<id>/, dev harness from /).
				base: './',
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
			}
		}
	}
}

// ── hostApps ──────────────────────────────────────────────────────────────

/** Reference to an app package by package name. */
export type AppRef = string

/** Either a list (id derived from package name) or an explicit id→ref map. */
export type HostAppsArg = AppRef[] | Record<string, AppRef>

export interface HostAppsOptions {
	/** URL prefix the host serves apps under. Defaults to `/apps/`. */
	urlPrefix?: string
}

const VIRTUAL_ID = 'virtual:@justfiles/apps'
const RESOLVED_ID = `\0${VIRTUAL_ID}`

interface ResolvedApp {
	id: string
	contentDir: string
	manifest: Manifest
}

export function hostApps(arg: HostAppsArg, opts: HostAppsOptions = {}): Plugin {
	const urlPrefix = (opts.urlPrefix ?? '/apps/').replace(/\/?$/, '/')
	let resolved: ResolvedApp[] | undefined

	const ensureResolved = (): ResolvedApp[] => {
		if (resolved) return resolved
		const require = createRequire(path.join(process.cwd(), 'package.json'))
		const pairs = Array.isArray(arg)
			? arg.map((ref) => [null, ref] as const)
			: Object.entries(arg).map(([k, ref]) => [k, ref] as const)
		const seen = new Set<string>()
		const out: ResolvedApp[] = []
		for (const [explicitId, ref] of pairs) {
			const id = explicitId ?? deriveId(ref)
			if (seen.has(id)) {
				throw new Error(
					`hostApps: duplicate id "${id}" — use the object form ({ "${id}": ref, "${id}-alt": otherRef }) to disambiguate.`
				)
			}
			seen.add(id)
			out.push(resolveInstalledApp(require, id, ref))
		}
		resolved = out
		return out
	}

	return {
		name: '@justfiles/app:host',
		resolveId(id) {
			if (id === VIRTUAL_ID) return RESOLVED_ID
			return undefined
		},
		load(id) {
			if (id !== RESOLVED_ID) return undefined
			const apps = ensureResolved()
			const entries = apps.map((a) => [a.id, { manifest: a.manifest }] as const)
			return `export const registry = new Map(${JSON.stringify(entries)})\n`
		},
		// Dev: serve `/apps/<id>/*` from each package's dist on disk so the
		// worker's ASSETS.fetch resolves through the dev server's static
		// pipeline (cloudflare/vite-plugin proxies to it).
		configureServer(server) {
			const apps = ensureResolved()
			const byId = new Map(apps.map((a) => [a.id, a.contentDir]))
			server.middlewares.use((req, res, next) => {
				if (!req.url) return next()
				const url = new URL(req.url, 'http://_')
				if (!url.pathname.startsWith(urlPrefix)) return next()
				const tail = url.pathname.slice(urlPrefix.length)
				const slash = tail.indexOf('/')
				if (slash === -1) return next()
				const appId = tail.slice(0, slash)
				const subpath = tail.slice(slash + 1)
				const dir = byId.get(appId)
				if (!dir || subpath.length === 0 || subpath.includes('..')) return next()
				const filePath = path.join(dir, subpath)
				if (!filePath.startsWith(`${dir}${path.sep}`) && filePath !== dir) return next()
				if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return next()
				res.setHeader('content-type', mimeFor(filePath))
				fs.createReadStream(filePath).pipe(res)
			})
		},
		// Build: ship every file under each app's content dir as a static
		// asset of the host build. Only fires for the client env — that
		// outDir is what @cloudflare/vite-plugin packages as the worker's
		// static-assets directory. Inline check (rather than the plugin-
		// wide `applyToEnvironment`) keeps `resolveId`/`load`/`configureServer`
		// active in every env so the virtual module still resolves from the
		// worker bundle.
		generateBundle() {
			if (this.environment?.name !== 'client') return
			const apps = ensureResolved()
			for (const app of apps) {
				for (const rel of walkFiles(app.contentDir)) {
					const abs = path.join(app.contentDir, rel)
					this.emitFile({
						type: 'asset',
						fileName: `apps/${app.id}/${rel.split(path.sep).join('/')}`,
						source: fs.readFileSync(abs)
					})
				}
			}
		}
	}
}

function resolveInstalledApp(
	require: ReturnType<typeof createRequire>,
	id: string,
	pkgName: string
): ResolvedApp {
	let mainPath: string
	try {
		mainPath = require.resolve(pkgName)
	} catch (e) {
		throw new Error(
			`hostApps: cannot resolve package "${pkgName}". Is it installed and built? Underlying: ${String(e)}`
		)
	}
	const contentDir = path.dirname(mainPath)
	const manifestPath = path.join(contentDir, 'manifest.json')
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`hostApps: ${pkgName} is missing manifest.json at ${manifestPath}.`)
	}
	const manifest = readJson<Manifest>(manifestPath)
	if (manifest.format !== FORMAT_VERSION) {
		throw new Error(
			`hostApps: ${pkgName} has format ${manifest.format}, expected ${FORMAT_VERSION}`
		)
	}
	return { id, contentDir, manifest }
}

function* walkFiles(dir: string, prefix = ''): Iterable<string> {
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name)
		const rel = prefix ? path.join(prefix, name) : name
		const stat = fs.statSync(full)
		if (stat.isDirectory()) {
			yield* walkFiles(full, rel)
		} else if (stat.isFile()) {
			yield rel
		}
	}
}

function deriveId(pkgName: string): string {
	const tail = pkgName.includes('/') ? (pkgName.split('/').pop() ?? pkgName) : pkgName
	return tail.replace(/^app-/, '')
}

function readJson<T>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

const MIME_BY_EXT: Record<string, string> = {
	html: 'text/html; charset=utf-8',
	js: 'application/javascript; charset=utf-8',
	mjs: 'application/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	json: 'application/json; charset=utf-8',
	svg: 'image/svg+xml',
	wasm: 'application/wasm',
	wad: 'application/octet-stream',
	cfg: 'text/plain; charset=utf-8',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp'
}
function mimeFor(filePath: string): string {
	const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
	return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

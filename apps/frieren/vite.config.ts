import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import { buildRuntime } from '@justfiles/app/devkit-runtime'
import { sdkExternals, vendorUrl } from '@justfiles/app/sdk-externals'
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import replace from '@rollup/plugin-replace'
import terser from '@rollup/plugin-terser'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { rollup } from 'rollup'
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { appstore } from './vite-appstore.ts'

// Resolve the React stdlib to /vendor/*.js URLs in BOTH dev and prod.
// Pairs with the importmap in index.html and the kernelHost plugin: kernel
// apps externalise the same specifiers and the browser resolves them via
// the importmap to the same /vendor URLs. One URL → one module instance →
// singleton React across host and every app.
//
// The bundles are a build cache under node_modules/.cache/vendor (alongside
// Vite's own caches there); they're regenerated on demand inside this
// plugin's buildStart hook. Dev serves them via a tiny middleware; build
// copies them into dist/client/vendor/. They stay out of /public, which
// Vite forbids using as import targets.
const VENDOR_URLS: Record<string, string> = {
	react: '/vendor/react.js',
	'react-dom': '/vendor/react-dom.js',
	'react-dom/client': '/vendor/react-dom-client.js',
	'react/jsx-runtime': '/vendor/jsx-runtime.js',
	'react/jsx-dev-runtime': '/vendor/jsx-dev-runtime.js'
}

// The host importmap a mini-app's gui.js resolves bare specifiers through: the shared
// React (above) plus the SDK half generated from the externals constant (URLs mirror the
// specifier), so a new capability needs no edit. Injected into index.html (transformIndexHtml).
// This is the document seam ONLY — frieren's own bundle resolves @justfiles/app normally;
// the SDK vendor is for blob-imported guis (and the served URL the reducer fetches, Step 3).
const IMPORTMAP = JSON.stringify({
	imports: {
		...VENDOR_URLS,
		...Object.fromEntries(sdkExternals.map(({ spec }) => [spec, vendorUrl(spec)]))
	}
})

interface VendorTarget {
	specifier: string
	external: string[]
}

// React ships as CJS; the per-target interop wrapper turns it into named-
// export ESM. For non-react targets we externalise `react` so the bundle
// does NOT inline its own copy of React internals — every vendor module
// reaches through /vendor/react.js (via the importmap) for the shared
// __CLIENT_INTERNALS dispatcher. Without this, each vendor file ends up
// with its own React and hooks fail with the "Invalid hook call" /
// two-Reacts error.
//
// We use Rollup directly (instead of esbuild) because esbuild's `external`
// would also match react/jsx-runtime against the `react` glob — there is
// no precise-match form. Rollup's function-form external is exact.
//
// All targets are bundled with NODE_ENV=development. The dev JSX runtime
// only ships its real implementation in the development CJS file (the
// production file sets jsxDEV = void 0). Splitting per-env is a v2 task;
// current cost is ~150KB of dev React in prod builds.
const VENDOR_TARGETS: Record<string, VendorTarget> = {
	'react.js': { specifier: 'react', external: [] },
	'react-dom.js': { specifier: 'react-dom', external: ['react'] },
	'react-dom-client.js': { specifier: 'react-dom/client', external: ['react'] },
	'jsx-runtime.js': { specifier: 'react/jsx-runtime', external: ['react'] },
	'jsx-dev-runtime.js': { specifier: 'react/jsx-dev-runtime', external: ['react'] }
}

const VENDOR_DIR = path.resolve(__dirname, 'node_modules/.cache/vendor')
const VENDOR_CACHE_KEY_FILE = path.join(VENDOR_DIR, '.cache-key')
const isValidIdent = (name: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)

// Cache key folds in the resolved React version so a `pnpm update react`
// invalidates the cache automatically. Bump VENDOR_BUILD_REV when the
// bundling logic itself changes (e.g. swap of plugins).
const VENDOR_BUILD_REV = 1
function vendorCacheKey(): string {
	const reactPkg = createRequire(path.join(__dirname, 'package.json'))('react/package.json') as {
		version: string
	}
	return `react@${reactPkg.version}|rev=${VENDOR_BUILD_REV}`
}

function vendorCacheIsCurrent(key: string): boolean {
	try {
		if (readFileSync(VENDOR_CACHE_KEY_FILE, 'utf8') !== key) return false
		for (const name of Object.keys(VENDOR_TARGETS)) statSync(path.join(VENDOR_DIR, name))
		return true
	} catch {
		return false
	}
}

async function buildVendorBundles(logger?: ResolvedConfig['logger']): Promise<void> {
	const require_ = createRequire(path.join(__dirname, 'package.json'))
	mkdirSync(VENDOR_DIR, { recursive: true })
	const tmp = path.resolve(__dirname, 'node_modules/.cache/vendor-entries')
	mkdirSync(tmp, { recursive: true })
	for (const [file, target] of Object.entries(VENDOR_TARGETS)) {
		const mod = require_(target.specifier) as Record<string, unknown>
		const names = Object.keys(mod).filter(isValidIdent).sort()
		const entry = path.join(tmp, file.replace(/\.js$/, '.entry.js'))
		writeFileSync(
			entry,
			`import __m from ${JSON.stringify(target.specifier)}\n` +
				`const { ${names.join(', ')} } = __m\n` +
				`export { ${names.join(', ')} }\n` +
				`export default __m\n`
		)
		const exact = new Set(target.external)
		const bundle = await rollup({
			input: entry,
			external: (id) => exact.has(id),
			plugins: [
				nodeResolve({ browser: true, exportConditions: ['default'] }),
				replace({
					preventAssignment: true,
					values: { 'process.env.NODE_ENV': JSON.stringify('development') }
				}),
				commonjs(),
				terser()
			],
			onwarn: (warning) => {
				if (warning.code === 'CIRCULAR_DEPENDENCY') return
				logger?.warn(`[vendor-react] ${warning.message}`)
			}
		})
		await bundle.write({ file: path.join(VENDOR_DIR, file), format: 'es', sourcemap: false })
		await bundle.close()
	}
}

// The SDK vendor modules (the host's `buildRuntime` output) written beside the React
// ones, served at `/vendor/<spec>.js`. Built every Vite invocation (not cached on React's
// version key) so editing @justfiles/app source reflects in dev; it's a few fast esbuild
// passes. Nested `@justfiles/…` specifiers need their dirs made.
async function buildSdkVendor(): Promise<void> {
	mkdirSync(VENDOR_DIR, { recursive: true })
	for (const [spec, text] of Object.entries(await buildRuntime())) {
		const file = path.join(VENDOR_DIR, `${spec}.js`)
		mkdirSync(path.dirname(file), { recursive: true })
		writeFileSync(file, text)
	}
}

function vendorReact(): Plugin {
	let mode: 'serve' | 'build' = 'serve'
	let logger: ResolvedConfig['logger'] | undefined
	let buildPromise: Promise<void> | undefined
	return {
		name: 'frieren:vendor-react',
		enforce: 'pre',
		config(_, env) {
			mode = env.command
		},
		configResolved(resolved) {
			logger = resolved.logger
		},
		async buildStart() {
			// One sub-build per Vite invocation, memoised. The React stdlib is cached on
			// React's version + a manual revision; the SDK vendor is rebuilt every start
			// (cheap esbuild) so live @justfiles/app edits reflect in dev.
			if (buildPromise) return buildPromise
			buildPromise = (async () => {
				const key = vendorCacheKey()
				if (!vendorCacheIsCurrent(key)) {
					const t0 = Date.now()
					logger?.info(`[vendor-react] building React stdlib (${key})…`)
					await buildVendorBundles(logger)
					writeFileSync(VENDOR_CACHE_KEY_FILE, key)
					logger?.info(`[vendor-react] done in ${Date.now() - t0}ms`)
				}
				await buildSdkVendor()
			})()
			return buildPromise
		},
		// Inject the host importmap (React + SDK) ahead of every module script so a
		// blob-imported gui.js resolves its bare specifiers to the shared /vendor modules.
		transformIndexHtml() {
			return [
				{
					tag: 'script',
					attrs: { type: 'importmap' },
					children: IMPORTMAP,
					injectTo: 'head-prepend'
				}
			]
		},
		resolveId(id) {
			const url = VENDOR_URLS[id]
			if (url) return { id: url, external: true }
			return null
		},
		// Vite dev still walks the import graph for externalised URLs and
		// errors when it cannot find the file on disk. Returning an empty
		// module silences the pre-transform error; the browser hits the URL
		// through the middleware below, which serves the real bytes.
		load(id) {
			if (Object.values(VENDOR_URLS).includes(id)) return ''
			return null
		},
		configureServer(server) {
			server.middlewares.use('/vendor', (req, res, next) => {
				const file = path.join(VENDOR_DIR, (req.url ?? '').split('?')[0] ?? '')
				if (!file.startsWith(VENDOR_DIR)) return next()
				let stat: ReturnType<typeof statSync>
				try {
					stat = statSync(file)
				} catch {
					return next()
				}
				if (!stat.isFile()) return next()
				res.setHeader('content-type', 'application/javascript; charset=utf-8')
				res.setHeader('cache-control', 'no-cache')
				const stream = require('node:fs').createReadStream(file)
				stream.pipe(res)
			})
		},
		async writeBundle() {
			// On build we need the vendor files alongside the rest of dist/.
			// emitFile would let Rollup write them, but Vite empties outDir
			// only inside its own client build — emitting from this plugin
			// (which sits in every environment) double-writes. Plain file
			// copy here is simpler and runs once after the client bundle.
			if (mode !== 'build') return
			const out = path.resolve(__dirname, 'dist/client/vendor')
			const { copyFileSync, mkdirSync: mkdir, readdirSync } = await import('node:fs')
			// Recursive copy so nested SDK vendor modules (`@justfiles/….js`) land too.
			const copyTree = (from: string, to: string): void => {
				mkdir(to, { recursive: true })
				for (const entry of readdirSync(from, { withFileTypes: true })) {
					const src = path.join(from, entry.name)
					const dst = path.join(to, entry.name)
					if (entry.isDirectory()) copyTree(src, dst)
					else if (entry.name.endsWith('.js')) copyFileSync(src, dst)
				}
			}
			copyTree(VENDOR_DIR, out)
		}
	}
}

export default defineConfig({
	server: {
		// In dev, @cloudflare/vite-plugin serves the worker's `env.ASSETS.fetch()`
		// through this dev server. Those requests carry the synthetic `assets.invalid`
		// host the worker uses (the real ASSETS binding ignores the host — see
		// worker/frieren.app.ts), which Vite's host check would otherwise 403,
		// silently breaking the server-side built-in reconcile.
		allowedHosts: ['assets.invalid']
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src')
		}
	},
	optimizeDeps: {
		// Skip Vite prebundle for the externalised stdlib; resolveId
		// short-circuits these to URL imports before optimizer ever runs.
		exclude: Object.keys(VENDOR_URLS)
	},
	plugins: [
		vendorReact(),
		appstore(),
		// NOTE: VitePWA conflicts with @cloudflare/vite-plugin when vitest resolves
		// THIS config (e.g. `cd apps/frieren && vitest`); the canonical root
		// `vitest.config.ts` has no plugins and is unaffected. Run tests from root.
		VitePWA({
			// We register the SW ourselves in pwa.ts (PROD only), so no injected
			// registration and no dev SW; skipWaiting/clientsClaim drive updates.
			registerType: 'autoUpdate',
			injectRegister: false,
			manifest: {
				name: 'Frieren',
				short_name: 'Frieren',
				description: 'Local-first Frieren workspace',
				start_url: '/',
				scope: '/',
				display: 'standalone',
				background_color: '#020617',
				theme_color: '#020617',
				// SVG has no maskable safe-zone padding, so claim `any` only to avoid
				// cropping on circular masks.
				icons: [{ src: '/pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
			},
			workbox: {
				skipWaiting: true,
				clientsClaim: true,
				cleanupOutdatedCaches: true,
				navigateFallback: '/index.html',
				navigateFallbackDenylist: [/^\/api\//, /^\/fs\//, /^\/ws$/],
				// Built-in app files are .js/.svg (already matched); add the catalog +
				// per-app manifest.json so a warm browser can seed a new profile offline.
				globPatterns: [
					'**/*.{js,css,html,svg,png,jpg,jpeg,avif,webp,woff2,webmanifest}',
					'appstore/**/*.json'
				]
			}
		}),
		tailwindcss(),
		react(),
		cloudflare()
	]
})

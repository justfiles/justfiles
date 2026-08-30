import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { RUNNER_CACHE_MAX_ENTRIES, RUNNER_CACHE_NAME } from './shared/appstore.ts'
import { appstore } from './vite-appstore.ts'

// WHICH BUILD THIS IS, stamped in here because only the build knows: the running bundle
// cannot ask a server what it is, and a version number alone does not always name one
// build. Staging redeploys from `main` on every push (see the deploy workflow), so its
// version number names every commit since the last release — the head commit is what tells
// two staging builds apart. Production deploys from a `frieren-v*` tag, where the version
// number IS the build and a commit would only be noise. Settings prints it verbatim
// (`host.version`; see src/apps/capabilities.client.ts).
function buildVersion(): string {
	const { version } = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as {
		version: string
	}
	if (process.env.CLOUDFLARE_ENV !== 'staging') return version
	// GitHub Actions hands the commit it checked out; a local staging build asks git.
	const sha =
		process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
	return `${version}+${sha.trim().slice(0, 7)}`
}

export default defineConfig({
	define: {
		'import.meta.env.VITE_FRIEREN_VERSION': JSON.stringify(buildVersion())
	},
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
	worker: { format: 'es' },
	environments: {
		// Feeds `upload_source_maps` (wrangler.jsonc), which only ships maps that
		// already exist: this plugin bundles the worker itself and sets `no_bundle`,
		// so wrangler never runs esbuild and locates maps solely by the trailing
		// `//# sourceMappingURL=` comment on each chunk. Hence `true`, not 'hidden' —
		// hidden drops that comment and wrangler silently uploads nothing. Client
		// stays unmapped; its maps would be publicly served. The key is the
		// top-level `name` with `-` replaced by `_` — NOT the per-env name, so
		// CLOUDFLARE_ENV=staging (worker `frieren-staging`) builds through this
		// same key.
		frieren: { build: { sourcemap: true } }
	},
	plugins: [
		appstore(),
		// NOTE: VitePWA conflicts with @cloudflare/vite-plugin when vitest resolves
		// THIS config (e.g. `cd platform/frieren && vitest`); the canonical root
		// `vitest.config.ts` has no plugins and is unaffected. Run tests from root.
		VitePWA({
			// We register the SW ourselves via registerSW() in pwa.ts, so no injected
			// registration and no dev SW. `prompt` lets a new SW install and wait; usePWA
			// surfaces a toast and the user opts into the reload — safer than reloading
			// automatically over unsaved editor state.
			registerType: 'prompt',
			injectRegister: false,
			manifest: {
				name: 'Just Computer',
				short_name: 'Just Computer',
				description: 'Your local-first computer',
				start_url: '/',
				scope: '/',
				display: 'standalone',
				background_color: '#020617',
				theme_color: '#020617',
				// PNGs generated from the built-in avatar (see scripts/generate-icons.ts): square
				// `any` icons plus a maskable one carrying its own safe-zone padding.
				icons: [
					{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
					{ src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
					{
						src: '/pwa-maskable-512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable'
					}
				]
			},
			workbox: {
				cleanupOutdatedCaches: true,
				clientsClaim: true,
				navigateFallback: '/index.html',
				navigateFallbackDenylist: [/^\/api\//, /^\/fs\//, /^\/store\//, /^\/ws$/],
				// Runner release URLs are immutable. Cache them on first use so an installed
				// app's mounted GUI/assets keep working with no network; the volume retains
				// only its manifest and reducer. Bound the cache so superseded releases cannot
				// accumulate forever; a hash failure also evicts its exact entry in the kernel.
				runtimeCaching: [
					{
						urlPattern:
							/\/assets\/(?:devkit\.toolchain(?:\.worker|\.typescript)?-[^/]+\.js|esbuild-[^/]+\.wasm)$/,
						handler: 'CacheFirst',
						options: {
							cacheName: 'justfiles-devkit-toolchain-v1',
							expiration: { maxEntries: 4, purgeOnQuotaError: true }
						}
					},
					{
						urlPattern: /^https:\/\/[^/]+\.justapps\.run\/v\/[^/]+\//,
						handler: 'CacheFirst',
						options: {
							cacheName: RUNNER_CACHE_NAME,
							cacheableResponse: { statuses: [200] },
							expiration: {
								maxEntries: RUNNER_CACHE_MAX_ENTRIES,
								purgeOnQuotaError: true
							}
						}
					}
				],
				// Built-in app files are .js/.svg (already matched); add the catalog +
				// per-app manifest.json so a warm browser can seed a new profile offline.
				globPatterns: [
					'**/*.{js,css,html,svg,png,jpg,jpeg,avif,webp,woff2,webmanifest}',
					'appstore/**/*.json'
				],
				globIgnores: ['**/devkit.toolchain*.js']
			}
		}),
		react(),
		cloudflare()
	]
})

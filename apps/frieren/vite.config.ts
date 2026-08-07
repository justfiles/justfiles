import path from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { appstore } from './vite-appstore.ts'

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
	environments: {
		// Feeds `upload_source_maps` (wrangler.jsonc), which only ships maps that
		// already exist: this plugin bundles the worker itself and sets `no_bundle`,
		// so wrangler never runs esbuild and locates maps solely by the trailing
		// `//# sourceMappingURL=` comment on each chunk. Hence `true`, not 'hidden' —
		// hidden drops that comment and wrangler silently uploads nothing. Client
		// stays unmapped; its maps would be publicly served. Environment name is the
		// worker name with `-` replaced by `_`.
		frieren: { build: { sourcemap: true } }
	},
	plugins: [
		appstore(),
		// NOTE: VitePWA conflicts with @cloudflare/vite-plugin when vitest resolves
		// THIS config (e.g. `cd apps/frieren && vitest`); the canonical root
		// `vitest.config.ts` has no plugins and is unaffected. Run tests from root.
		VitePWA({
			// We register the SW ourselves via registerSW() in pwa.ts, so no injected
			// registration and no dev SW. `prompt` lets a new SW install and wait; usePWA
			// surfaces a toast and the user opts into the reload — safer than reloading
			// automatically over unsaved editor state.
			registerType: 'prompt',
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
				// PNGs generated from icon.png (see scripts/generate-icons.ts): square
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
		react(),
		cloudflare()
	]
})

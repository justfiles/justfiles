import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";

// Mirrors wrangler's text rule for *.sql so Vite handles them the same way
const sqlTextPlugin = {
	name: "sql-text",
	transform(code: string, id: string) {
		if (id.endsWith(".sql")) {
			return `export default ${JSON.stringify(code)}`
		}
	},
}

export default defineConfig({
	plugins: [
		tailwindcss(),
		sqlTextPlugin,
		react(),
		cloudflare(),
		VitePWA({
			strategies: "generateSW",
			registerType: "prompt",
			injectRegister: "inline",
			includeAssets: ["favicon.ico", "apple-touch-icon-180x180.png"],
			manifest: {
				name: "Ghostore",
				short_name: "Ghostore",
				description: "Your personal memory store",
				theme_color: "#ffffff",
				background_color: "#ffffff",
				display: "standalone",
				orientation: "portrait",
				scope: "/",
				start_url: "/",
				icons: [
					{ src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
					{ src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
					{ src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
					{ src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
				],
			},
			workbox: {
				globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
				navigateFallback: "/index.html",
				// Don't intercept Worker API or MCP routes
				navigateFallbackDenylist: [/^\/api/, /^\/mcp/],
				runtimeCaching: [
					{
						urlPattern: /^\/api\/.*/i,
						handler: "NetworkFirst",
						method: "GET",
						options: {
							cacheName: "api-cache",
							networkTimeoutSeconds: 5,
							expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 },
							cacheableResponse: { statuses: [0, 200] },
						},
					},
				],
			},
		}),
	],
});

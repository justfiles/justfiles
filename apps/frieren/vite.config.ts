import fs from 'node:fs'
import path from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import { hostApps } from '@justfiles/app/vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// Ship a kernel app's built bundle (app.js, gui.js, manifest.json) under
// `/apps/<id>/*` so the per-user DO can `env.ASSETS.fetch` + install it.
// `hostApps` can't carry it: it validates each manifest against the
// iframe/ESM-contract schemas (an `entry` field), whereas a kernel bundle's
// manifest is the `{ id, name, app, gui }` shape — the plan's Phase 3
// decision point. Dedicated emit, by path (robust to the in-progress
// app-hello package rename), mirroring hostApps' dev+build mechanism.
function kernelApp(id: string, dist: string): Plugin {
	const root = path.resolve(__dirname, dist)
	const mime = (f: string) =>
		f.endsWith('.json')
			? 'application/json; charset=utf-8'
			: 'application/javascript; charset=utf-8'
	const walk = (dir: string, pre = ''): string[] =>
		fs.readdirSync(dir).flatMap((n) => {
			const full = path.join(dir, n)
			const rel = pre ? `${pre}/${n}` : n
			return fs.statSync(full).isDirectory() ? walk(full, rel) : [rel]
		})
	return {
		name: 'frieren:kernel-app',
		configureServer(server) {
			const prefix = `/apps/${id}/`
			server.middlewares.use((req, res, next) => {
				if (!req.url?.startsWith(prefix)) return next()
				const sub = req.url.slice(prefix.length).split('?')[0]
				const file = path.join(root, sub)
				if (sub.includes('..') || !file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file))
					return next()
				res.setHeader('content-type', mime(file))
				fs.createReadStream(file).pipe(res)
			})
		},
		generateBundle() {
			if (this.environment?.name !== 'client') return
			for (const rel of walk(root))
				this.emitFile({
					type: 'asset',
					fileName: `apps/${id}/${rel}`,
					source: fs.readFileSync(path.join(root, rel))
				})
		}
	}
}

// https://vite.dev/config/
export default defineConfig({
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src')
		}
	},
	plugins: [
		tailwindcss(),
		react(),
		cloudflare(),
		// Client-only apps are referenced by package name because they
		// have no JS module to import.
		hostApps(['@justbuddy/app-doom', '@justfiles/app-crossword', '@justfiles/app-demo']),
		// app-hello is now a kernel app (packages/app-hello-bk is the
		// retired iframe original) — shipped via the dedicated emit, not
		// hostApps.
		kernelApp('hello', '../../packages/app-hello/dist')
	]
})

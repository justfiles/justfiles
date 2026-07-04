import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { vendorImportMap, vendorSpecs, vendorUrl } from './vendor.ts'

const ROOT = import.meta.dirname

// Replaces the old serve-time Bun HTML plugin (htmlImportmap.ts): resolves the vendored
// React specifiers to their `/vendor/*` URLs as runtime-external imports (so Vite never
// bundles a second React copy into the launcher/shell), injects the shared import map into
// each HTML <head> (which is what the per-app gui.js bare imports resolve through at
// runtime), and regenerates the vendor bundles into the build output.
function vendor(): Plugin {
	return {
		name: 'vendor',
		// `pre` so this resolveId runs before Vite's core resolver — otherwise Vite
		// resolves `react` to node_modules and bundles a second copy into the launcher/shell
		// chunks (the classic two-Reacts bug) before we get to externalize it.
		enforce: 'pre',
		resolveId: (id) =>
			(vendorSpecs as readonly string[]).includes(id)
				? { id: vendorUrl(id), external: true }
				: null,
		transformIndexHtml: () => [
			{
				tag: 'script',
				attrs: { type: 'importmap' },
				children: JSON.stringify(vendorImportMap()),
				injectTo: 'head-prepend'
			}
		],
		// Regenerate the vendored React bundles into the build output. They must be built by
		// Bun (vendor.ts uses Bun.build, which hoists react-dom's CJS `require("react")` to an
		// ESM import — esbuild emits a throwing __require shim for a browser external), so
		// spawn it rather than calling in-process under Vite's Node runtime. closeBundle runs
		// after Vite has emptied + written dist/client, so the files never race the
		// emptyOutDir wipe.
		closeBundle: () =>
			void execFileSync('bun', [resolve(ROOT, 'vendor.ts'), resolve(ROOT, 'dist/client/vendor')], {
				stdio: 'inherit'
			})
	}
}

export default defineConfig({
	root: ROOT,
	// Absolute asset URLs so app/shell.html (served at /app/:id) still resolves /assets + /vendor.
	base: '/',
	build: {
		outDir: 'dist/client',
		emptyOutDir: true,
		rollupOptions: {
			input: {
				launcher: resolve(ROOT, 'launcher/index.html'),
				chat: resolve(ROOT, 'launcher/chat.html'),
				shell: resolve(ROOT, 'app/shell.html')
			}
		}
	},
	plugins: [react(), vendor()]
})

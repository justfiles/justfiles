// Serve-time injector for the shell's import map. Registered via bunfig.toml's
// `[serve.static].plugins`, this `onLoad` hook runs while Bun bundles `shell.html`
// for the `/app/:id` route (so `./main.ts` and the design CSS are still bundled as
// usual — we only rewrite the HTML string passing through). It fills the empty
// `<script type="importmap">{}</script>` placeholder with `vendorImportMap()`, the
// same source the vendor modules are generated from, so the map can never drift
// from what `/vendor/*` actually serves.

import type { BunPlugin } from 'bun'
import { vendorImportMap } from './vendor'

const htmlImportmap: BunPlugin = {
	name: 'quay-html-importmap',
	setup(build) {
		const rewriter = new HTMLRewriter().on('script[type="importmap"]', {
			element(el) {
				// `html: true` inserts the JSON verbatim; the map's values are URL paths
				// with no HTML-sensitive characters, so nothing needs escaping.
				el.setInnerContent(JSON.stringify(vendorImportMap()), { html: true })
			}
		})

		build.onLoad({ filter: /\.html$/ }, async (args) => ({
			contents: rewriter.transform(await Bun.file(args.path).text()),
			loader: 'html'
		}))
	}
}

export default htmlImportmap

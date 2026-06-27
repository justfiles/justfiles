// Serve-time HTML bundler plugin. Registered via bunfig.toml's
// `[serve.static].plugins`, it runs while Bun bundles `shell.html` and the
// launcher. It fills the empty `<script type="importmap">{}</script>` placeholder
// with `vendorImportMap()`, and aliases React imports to one physical copy so
// workspace UI packages don't bundle their own React singleton.

import { createRequire } from 'node:module'
import type { BunPlugin } from 'bun'
import { vendorImportMap } from './vendor'

const require = createRequire(import.meta.url)
const reactSingletons = new Map(
	['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(
		(spec) => [spec, require.resolve(spec)]
	)
)

const htmlImportmap: BunPlugin = {
	name: 'quay-html-importmap',
	setup(build) {
		build.onResolve(
			{ filter: /^react(?:\/jsx-runtime|\/jsx-dev-runtime)?$|^react-dom(?:\/client)?$/ },
			(args) => ({
				path: reactSingletons.get(args.path) ?? args.path
			})
		)

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

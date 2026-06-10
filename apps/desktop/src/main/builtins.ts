import { createHash } from 'node:crypto'
import type { Catalog, CatalogApp } from '@justfiles/app/builtins'
import type { BuiltinBundle } from '@justfiles/app/runtime'
import code from '@justfiles/app-code/bundle'
import counter from '@justfiles/app-counter/bundle'
import finder from '@justfiles/app-finder/bundle'
import paint from '@justfiles/app-paint/bundle'
import settings from '@justfiles/app-settings/bundle'

const bundles = [counter, finder, paint, settings, code]
const byId = new Map(bundles.map((bundle) => [bundle.id, bundle]))

export const desktopBuiltinCatalog: Catalog = {
	schema: 'justfiles.appstore.v1',
	apps: bundles.map(toCatalogApp)
}

export async function readDesktopBuiltin(app: CatalogApp, path: string): Promise<Uint8Array> {
	const bundle = byId.get(app.id)
	const bytes = bundle?.files[path]
	if (!bytes) throw new Error(`builtin not found: ${app.id}/${path}`)
	return bytes
}

function toCatalogApp(bundle: BuiltinBundle): CatalogApp {
	return {
		id: bundle.id,
		name: bundle.manifest.name,
		version: bundle.version,
		icon: bundle.manifest.icon,
		files: Object.entries(bundle.files)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([path, bytes]) => ({
				path,
				hash: `sha256-${createHash('sha256').update(bytes).digest('hex')}`,
				size: bytes.byteLength
			}))
	}
}

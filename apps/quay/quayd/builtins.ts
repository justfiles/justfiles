// The built-in catalog quayd seeds on first run: Code (the app you build others
// with) + Finder, plus Counter — a no-capability app that exercises the full berth
// round-trip end-to-end before capabilities land (Slice 9). Mirrors the desktop
// sibling's packaging — each bundle's bytes live in its generated `dist/bundle.js`,
// hashed into a `Catalog` so `reconcileBuiltins` reinstalls only the apps whose
// bytes actually changed.

import { createHash } from 'node:crypto'
import type { Catalog, CatalogApp } from '@justfiles/app/builtins'
import type { BuiltinBundle } from '@justfiles/app/runtime'
import code from '@justfiles/app-code/bundle'
import counter from '@justfiles/app-counter/bundle'
import finder from '@justfiles/app-finder/bundle'

const bundles: BuiltinBundle[] = [code, finder, counter]
const byId = new Map(bundles.map((bundle) => [bundle.id, bundle]))

export const builtinCatalog: Catalog = {
	schema: 'justfiles.appstore.v1',
	apps: bundles.map(toCatalogApp)
}

export async function readBuiltin(app: CatalogApp, path: string): Promise<Uint8Array> {
	const bytes = byId.get(app.id)?.files[path]
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

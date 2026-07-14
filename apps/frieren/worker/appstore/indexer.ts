// The community-store indexer's PURE core: it turns already-fetched npm/jsDelivr
// metadata into a catalog, applying validation, the reserved-prefix guard, the
// two-way id<->package binding (first claim wins), and the denylist. It touches
// no network and no bytes beyond the manifest text it's handed — the I/O lives in
// `feed.ts`. Kept pure so the whole decision surface is unit-testable.

import type { CatalogFile } from '@justfiles/app/appstore'
import type { CommunityCatalog, CommunityCatalogApp } from '../../shared/appstore.ts'
import { COMMUNITY_CATALOG_SCHEMA } from '../../shared/appstore.ts'

// Ids under these prefixes are first-party and only honoured from our npm scope
// (the prefix guard); everyone else must use their own reverse-DNS namespace.
const RESERVED_PREFIXES = ['computer.spud.', 'app.frieren.', 'app.spud.']
const SPUD_SCOPE = '@spud-computer/'

export interface Denylist {
	names: string[] // banned npm package names
	ids: string[] // banned app ids
}

// One npm package@version, with its dist metadata already fetched. `manifest` is
// the raw `dist/manifest.json` text (null when absent/unfetchable); `files` are
// the dist files with paths relative to `dist/` and `sha256-<hex>` hashes.
export interface IndexInput {
	npm: string
	version: string
	publisher: string
	repository?: string
	description?: string
	manifest: string | null
	files: CatalogFile[]
}

export interface IndexFlag {
	npm: string
	version: string
	reason: string
}

interface Manifest {
	id: string
	name: string
	icon?: string
	app?: string
}

export function isReverseDns(id: string): boolean {
	// >=2 dot-separated segments; each segment is alphanumeric with internal hyphens.
	return /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/i.test(id)
}

function isReserved(id: string): boolean {
	return RESERVED_PREFIXES.some((p) => id.startsWith(p))
}

function fromSpudScope(npm: string): boolean {
	return npm.startsWith(SPUD_SCOPE)
}

export function parseManifest(json: string | null): Manifest | null {
	if (!json) return null
	try {
		const m = JSON.parse(json) as Manifest
		if (typeof m.id !== 'string' || typeof m.name !== 'string') return null
		return m
	} catch {
		return null
	}
}

// The catalog must be able to fetch the manifest and the app entry from jsDelivr,
// so both must be present in the pinned file set.
function hasRequiredFiles(files: CatalogFile[], manifest: Manifest): boolean {
	const paths = new Set(files.map((f) => f.path))
	return paths.has('manifest.json') && paths.has(manifest.app ?? 'app.js')
}

// Build the next community catalog from the current npm/jsDelivr inputs and the
// PREVIOUS catalog (which is the binding store — read, merge, write). Bindings
// are seeded from `previous` so first claims persist across runs; each input is
// then validated and bound (both ways, first claim wins). Anything rejected is
// recorded in `flags` rather than silently dropped.
export function buildCatalog(
	inputs: IndexInput[],
	previous: CommunityCatalog,
	denylist: Denylist
): { catalog: CommunityCatalog; flags: IndexFlag[] } {
	const flags: IndexFlag[] = []
	const bannedNames = new Set(denylist.names)
	const bannedIds = new Set(denylist.ids)

	// Merge onto the previous set: retained apps keep their bindings even if a run
	// doesn't re-surface them (transient npm search gaps don't drop apps).
	const byNpm = new Map<string, CommunityCatalogApp>(previous.apps.map((a) => [a.npm, a]))
	const idToNpm = new Map<string, string>(previous.apps.map((a) => [a.id, a.npm]))

	for (const input of inputs) {
		const flag = (reason: string) => flags.push({ npm: input.npm, version: input.version, reason })

		if (bannedNames.has(input.npm)) continue // denylisted package — skip quietly

		const manifest = parseManifest(input.manifest)
		if (!manifest) {
			flag('manifest missing or malformed')
			continue
		}
		const id = manifest.id
		if (bannedIds.has(id)) continue
		if (!isReverseDns(id)) {
			flag(`app id not reverse-DNS: ${id}`)
			continue
		}
		if (isReserved(id) && !fromSpudScope(input.npm)) {
			flag(`reserved-prefix id ${id} from foreign scope ${input.npm}`)
			continue
		}
		if (!hasRequiredFiles(input.files, manifest)) {
			flag('missing manifest.json or app entry in dist')
			continue
		}

		// Two-way binding, first claim wins.
		const boundNpm = idToNpm.get(id)
		if (boundNpm && boundNpm !== input.npm) {
			flag(`id ${id} already bound to ${boundNpm}`)
			continue
		}
		const existing = byNpm.get(input.npm)
		if (existing && existing.id !== id) {
			flag(`package changed its id (${existing.id} -> ${id})`)
			continue
		}

		byNpm.set(input.npm, {
			id,
			name: manifest.name,
			version: input.version,
			icon: manifest.icon,
			npm: input.npm,
			publisher: input.publisher,
			repository: input.repository,
			description: input.description,
			files: input.files
		})
		idToNpm.set(id, input.npm)
	}

	// Final denylist pass so a package/id banned after it was already indexed drops.
	const apps = [...byNpm.values()].filter((a) => !bannedNames.has(a.npm) && !bannedIds.has(a.id))
	return { catalog: { schema: COMMUNITY_CATALOG_SCHEMA, apps }, flags }
}

// A jsDelivr data-API tree node (`data.jsdelivr.com/v1/packages/npm/<pkg>`):
// files carry a base64 sha256 `hash` + `size`; directories nest `files`.
export interface JsDelivrNode {
	type: 'file' | 'directory'
	name: string
	hash?: string
	size?: number
	files?: JsDelivrNode[]
}

// Flatten the package's `dist/` subtree into catalog files: paths relative to
// `dist/`, hashes converted from jsDelivr's base64 sha256 to our `sha256-<hex>`.
export function distFiles(tree: JsDelivrNode[]): CatalogFile[] {
	const dist = tree.find((n) => n.type === 'directory' && n.name === 'dist')
	if (!dist?.files) return []
	const out: CatalogFile[] = []
	const walk = (nodes: JsDelivrNode[], prefix: string): void => {
		for (const n of nodes) {
			if (n.type === 'directory' && n.files) walk(n.files, `${prefix}${n.name}/`)
			else if (n.type === 'file' && n.hash != null)
				out.push({
					path: `${prefix}${n.name}`,
					hash: `sha256-${Buffer.from(n.hash, 'base64').toString('hex')}`,
					size: n.size ?? 0
				})
		}
	}
	walk(dist.files, '')
	return out
}

import type { AppManifest } from './app.ts'
import type { CatalogFile } from './appstore.ts'

export const MANIFEST_SCHEMA = 'justapps/manifest/v1'
export const STORE_SCHEMA = 'justapps/store/v1'

export interface ReleaseManifest {
	schema: typeof MANIFEST_SCHEMA
	id: string
	name: string
	description?: string
	version: string
	icon?: string
	app: string
	gui?: string
	cli?: string
	capabilities?: AppManifest['capabilities']
	hash: string
	files: CatalogFile[]
}

export interface StoreIndex {
	schema: typeof STORE_SCHEMA
	apps: StoreApp[]
}

export interface StoreApp {
	id: string
	name: string
	description?: string
	version: string
	iconUrl?: string
	manifestUrl: string
	repository?: string
}

// The hash includes the authored manifest, even though a store does not serve it
// as payload. This makes metadata-only changes update the release hash.
export async function appHash(
	files: Iterable<Pick<CatalogFile, 'path' | 'hash'>>
): Promise<string> {
	const input = [...files]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((file) => `${file.path}\0${file.hash}`)
		.join('\n')
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

// A store owns the id, version, hashes, and file list. Copy only app-authored
// fields that belong in the public release manifest.
export function releaseManifest(
	authored: AppManifest,
	release: Pick<ReleaseManifest, 'id' | 'version' | 'hash' | 'files'>
): ReleaseManifest {
	return {
		schema: MANIFEST_SCHEMA,
		id: release.id,
		name: authored.name,
		description: authored.description,
		version: release.version,
		icon: authored.icon,
		app: authored.app,
		gui: authored.gui,
		cli: authored.cli,
		capabilities: authored.capabilities,
		hash: release.hash,
		files: [...release.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
	}
}

import type { CatalogFile } from '@justfiles/app/appstore'
import type { CapabilityDecl } from '@justfiles/app/runtime'

/**
 * The wire format. Everything a client of this registry may read is one of the
 * two documents below, and both are STORED artifacts rather than responses
 * assembled per request — so what a device verifies is what we wrote, and the
 * serving path stays a byte pipe.
 *
 * See kb/registry.md#public-protocol.
 */

export const MANIFEST_SCHEMA = 'justapps/manifest/v1'
export const STORE_SCHEMA = 'justapps/store/v1'

/**
 * One release, canonically. The importer generates it by projecting the known
 * fields of the bundle's authored `manifest.json` and computing the rest;
 * authored `id`, `version`, `hash` and `files` never win, and an unknown
 * authored field is dropped rather than carried into anything we serve.
 *
 * **`baseUrl` is deliberately not part of the wire format.** A client derives it
 * from the final response URL of the manifest it fetched — `new URL('.',
 * response.url)` — and records it locally. That keeps the app id out of stored
 * release data (a future rename is a prefix move, not a rewrite of every
 * manifest we hold), lets a custom domain pin itself with nothing to guess, and
 * means the bytes we serve are the bytes we stored.
 */
export interface ReleaseManifest {
	schema: typeof MANIFEST_SCHEMA
	id: string
	name: string
	description?: string
	version: string
	/** Payload-relative, and so resolved against the client's derived base. */
	icon?: string
	app: string
	gui?: string
	cli?: string
	capabilities?: CapabilityDecl
	/**
	 * The whole-app fingerprint: every path and digest folded together, the
	 * authored manifest included. What a device compares to decide whether an
	 * installed app is still the published one.
	 */
	hash: string
	/**
	 * Every payload file, sorted by path, each with its digest and its ACTUAL
	 * byte size — which bounds a read before the hash can be checked. The reducer
	 * is in here; the authored `manifest.json` and host infrastructure are not.
	 */
	files: CatalogFile[]
}

/**
 * The browse index, rebuilt in full from R2 after every completed refresh. Thin
 * on purpose: it carries what a listing renders and the URL to ask for the rest,
 * so it does not grow with bundle size.
 */
export interface StoreIndex {
	schema: typeof STORE_SCHEMA
	apps: StoreApp[]
}

export interface StoreApp {
	id: string
	name: string
	description?: string
	version: string
	/** Version-pinned, so it is immutable and cacheable for a year. */
	iconUrl?: string
	/** The app origin's mutable pointer, which redirects to the current release. */
	manifestUrl: string
	repository?: string
}

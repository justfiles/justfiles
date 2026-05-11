// Fetches a manifest JSON URL and validates it against the new-contract
// `ManifestSchema`. Used by the host shell before handing a manifest to the
// App Loader.

import { Check, Errors } from 'typebox/value'
import { type Manifest, ManifestSchema } from './contract.js'

export interface LoadManifestOptions {
	url: string
	fetcher?: typeof fetch
}

export async function loadManifest(opts: LoadManifestOptions): Promise<Manifest> {
	const fetcher = opts.fetcher ?? fetch
	let response: Response
	try {
		response = await fetcher(opts.url)
	} catch (e) {
		throw new Error(`manifest fetch failed for ${opts.url}: ${String(e)}`)
	}
	if (!response.ok) {
		throw new Error(`manifest fetch failed for ${opts.url}: HTTP ${response.status}`)
	}
	let value: unknown
	try {
		value = await response.json()
	} catch (e) {
		throw new Error(`manifest at ${opts.url} is not valid JSON: ${String(e)}`)
	}
	if (!Check(ManifestSchema, value)) {
		const message = [...Errors(ManifestSchema, value)]
			.map((e) => `${e.instancePath || '/'} ${e.message}`)
			.join('; ')
		throw new Error(`manifest at ${opts.url} is invalid: ${message}`)
	}
	return value
}

// Discriminator: a `Manifest` (new shape) carries an `id` and lacks
// `format`/`name`. Callers branch on this before deciding which loader to
// use; the legacy iframe loader handles everything else.
export function isNewManifest(value: unknown): value is Manifest {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { id?: unknown }).id === 'string' &&
		typeof (value as { title?: unknown }).title === 'string' &&
		typeof (value as { entry?: unknown }).entry === 'string'
	)
}

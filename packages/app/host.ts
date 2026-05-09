// Canonical "source → AppEntry" pipeline. Every delivery channel — workspace
// package (build-time), npm package (build-time), R2 upload (runtime) —
// exposes an `AppPackageSource`. There is no other path to register an app.
//
// The source is stream-shaped on purpose: binary assets (wasm, wad, fonts)
// can be huge, and Cloudflare Workers have tight memory + bundle-size
// limits. The host loads only the manifest + backend code eagerly (small,
// always needed), and lazy-streams everything else through `open()`.

import { Check, Errors } from 'typebox/value'
import { FORMAT_VERSION, type Manifest, ManifestSchema } from './format.js'

export interface AppAsset {
	body: ReadableStream<Uint8Array>
	size?: number
	contentType?: string
}

export interface AppPackageSource {
	open(path: string): Promise<AppAsset | undefined>
}

export interface AppEntry {
	manifest: Manifest
	// Empty string for client-only apps (manifest omits `backend`).
	code: string
	open(path: string): Promise<AppAsset | undefined>
}

export type AppPackageErrorCode =
	| 'MISSING_MANIFEST'
	| 'INVALID_MANIFEST'
	| 'UNKNOWN_FORMAT'
	| 'MISSING_BACKEND'

export class AppPackageError extends Error {
	constructor(
		public readonly code: AppPackageErrorCode,
		message: string
	) {
		super(`${code}: ${message}`)
		this.name = 'AppPackageError'
	}
}

export async function loadAppPackage(src: AppPackageSource): Promise<AppEntry> {
	const manifestText = await readText(src, 'manifest.json')
	if (manifestText === undefined) {
		throw new AppPackageError('MISSING_MANIFEST', 'manifest.json not found in package')
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestText)
	} catch (e) {
		throw new AppPackageError('INVALID_MANIFEST', `manifest.json is not valid JSON: ${String(e)}`)
	}
	if (!Check(ManifestSchema, parsed)) {
		const errs = Errors(ManifestSchema, parsed)
			.map((e) => `${e.instancePath || '/'} ${e.message}`)
			.join('; ')
		throw new AppPackageError('INVALID_MANIFEST', `manifest schema violation: ${errs}`)
	}
	const manifest = parsed as Manifest
	if (manifest.format !== FORMAT_VERSION) {
		throw new AppPackageError(
			'UNKNOWN_FORMAT',
			`format ${manifest.format} not supported (expected ${FORMAT_VERSION})`
		)
	}
	let code = ''
	if (manifest.backend) {
		const loaded = await readText(src, manifest.backend)
		if (loaded === undefined) {
			throw new AppPackageError('MISSING_BACKEND', `backend file "${manifest.backend}" not found`)
		}
		code = loaded
	}
	return { manifest, code, open: (p) => src.open(p) }
}

async function readText(src: AppPackageSource, path: string): Promise<string | undefined> {
	const asset = await src.open(path)
	if (!asset) return undefined
	return new Response(asset.body).text()
}

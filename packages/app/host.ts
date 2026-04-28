// Canonical "bytes → AppEntry" pipeline. Every delivery channel — workspace
// package (build-time), npm package (build-time), zip upload (runtime) —
// converts its source into a FileBag and calls `loadAppPackage`. There is
// no other path to register an app.

import { Check, Errors } from 'typebox/value'
import { type FileBag, FORMAT_VERSION, type Manifest, ManifestSchema } from './format.js'

export interface AppEntry {
	manifest: Manifest
	code: string
	assets: Record<string, string>
}

export type AppPackageErrorCode =
	| 'MISSING_MANIFEST'
	| 'INVALID_MANIFEST'
	| 'UNKNOWN_FORMAT'
	| 'MISSING_BACKEND'
	| 'MISSING_ENTRY'

export class AppPackageError extends Error {
	constructor(
		public readonly code: AppPackageErrorCode,
		message: string
	) {
		super(`${code}: ${message}`)
		this.name = 'AppPackageError'
	}
}

export function loadAppPackage(files: FileBag): AppEntry {
	const raw = files['manifest.json']
	if (raw === undefined) {
		throw new AppPackageError('MISSING_MANIFEST', 'manifest.json not found in package')
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
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
	const code = files[manifest.backend]
	if (code === undefined) {
		throw new AppPackageError('MISSING_BACKEND', `backend file "${manifest.backend}" not found`)
	}
	const assets: Record<string, string> = {}
	for (const [path, content] of Object.entries(files)) {
		if (path === 'manifest.json' || path === manifest.backend) continue
		assets[path] = content
	}
	if (assets[manifest.entry] === undefined) {
		throw new AppPackageError('MISSING_ENTRY', `entry file "${manifest.entry}" not found`)
	}
	return { manifest, code, assets }
}

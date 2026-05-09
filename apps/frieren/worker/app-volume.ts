// Server-side handlers for `app.volume.*` JSON-RPC methods. The DO calls
// `executeVolumeOp` for an active app; we scope every path to
// `/apps/<appId>/` in the user volume so apps cannot read or overwrite
// each other's data through the bridge. The agent and human still have
// full access — this is a pre-grant scoping convention, not isolation.

import type { Volume } from '@justfiles/fs'

const APP_ROOT_PREFIX = '/apps'

export interface VolumeOpInput {
	method: string
	params: unknown
}

export interface VolumeOpOutput {
	result?: unknown
	error?: { code: string; message: string }
}

/** Resolve an app-relative path to an absolute volume path. The result is
 *  always a descendant of `/apps/<appId>/`. Rejects empty paths, non-string
 *  paths, and any path containing a `..` segment. */
export function scopeAppPath(appId: string, raw: unknown): string {
	if (typeof appId !== 'string' || appId.length === 0) {
		throw new VolumeError('EINVAL', 'app id is required')
	}
	if (typeof raw !== 'string' || raw.length === 0) {
		throw new VolumeError('EINVAL', 'path must be a non-empty string')
	}
	if (raw.includes('\0')) {
		throw new VolumeError('EINVAL', 'path may not contain null bytes')
	}
	const normalized = raw.startsWith('/') ? raw : `/${raw}`
	const segments = normalized.split('/').filter((s) => s.length > 0)
	for (const seg of segments) {
		if (seg === '..') throw new VolumeError('EINVAL', 'path may not contain `..`')
	}
	return `${APP_ROOT_PREFIX}/${appId}${segments.length === 0 ? '' : `/${segments.join('/')}`}`
}

export class VolumeError extends Error {
	readonly code: string
	constructor(code: string, message: string) {
		super(`${code}: ${message}`)
		this.code = code
		this.name = 'VolumeError'
	}
}

export async function executeVolumeOp(
	vol: Volume,
	appId: string,
	op: VolumeOpInput
): Promise<unknown> {
	const params = op.params as Record<string, unknown> | undefined
	const path = scopeAppPath(appId, params?.path)

	switch (op.method) {
		case 'app.volume.readText': {
			const bytes = await readOrThrow(vol, path)
			return new TextDecoder().decode(bytes)
		}
		case 'app.volume.writeText': {
			const data = params?.data
			if (typeof data !== 'string') {
				throw new VolumeError('EINVAL', 'data must be a string')
			}
			await ensureParent(vol, path)
			await vol.writeFile(path, new TextEncoder().encode(data))
			return null
		}
		case 'app.volume.readFile': {
			const bytes = await readOrThrow(vol, path)
			return uint8ToBase64(bytes)
		}
		case 'app.volume.writeFile': {
			const b64 = params?.bytes
			if (typeof b64 !== 'string') {
				throw new VolumeError('EINVAL', 'bytes must be a base64-encoded string')
			}
			let decoded: Uint8Array
			try {
				decoded = base64ToUint8(b64)
			} catch {
				throw new VolumeError('EINVAL', 'bytes is not valid base64')
			}
			await ensureParent(vol, path)
			await vol.writeFile(path, decoded)
			return null
		}
		default:
			throw new VolumeError('EMETHOD', `unknown volume method: ${op.method}`)
	}
}

async function readOrThrow(vol: Volume, path: string): Promise<Uint8Array> {
	try {
		return await vol.readFile(path)
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		if (msg.startsWith('ENOENT')) throw new VolumeError('ENOENT', `no such file: ${path}`)
		if (msg.startsWith('EISDIR')) throw new VolumeError('EISDIR', `is a directory: ${path}`)
		throw e
	}
}

async function ensureParent(vol: Volume, path: string): Promise<void> {
	const slash = path.lastIndexOf('/')
	if (slash <= 0) return
	const dir = path.slice(0, slash)
	if (await vol.exists(dir)) return
	await vol.mkdir(dir, { recursive: true })
}

function uint8ToBase64(bytes: Uint8Array): string {
	let str = ''
	for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i] ?? 0)
	return btoa(str)
}

function base64ToUint8(b64: string): Uint8Array {
	const str = atob(b64)
	const out = new Uint8Array(str.length)
	for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i)
	return out
}

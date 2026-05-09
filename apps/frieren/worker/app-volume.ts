// Volume handlers for the host RPC pipe. Each handler is a typed entry in
// the global `HostHandlers` map; the DO assembles them into its registry.
// Every path is scoped to `/apps/<appId>/` so apps cannot read or
// overwrite each other through the bridge.

import type { Volume } from '@justfiles/fs'
import { type HostHandlers, HostMethodError } from './app-host'

const APP_ROOT_PREFIX = '/apps'

/** Resolve an app-relative path to an absolute volume path. The result is
 *  always a descendant of `/apps/<appId>/`. Rejects empty paths, non-string
 *  paths, and any path containing a `..` segment. */
export function scopeAppPath(appId: string, raw: unknown): string {
	if (typeof appId !== 'string' || appId.length === 0) {
		throw new HostMethodError('EINVAL', 'app id is required')
	}
	if (typeof raw !== 'string' || raw.length === 0) {
		throw new HostMethodError('EINVAL', 'path must be a non-empty string')
	}
	if (raw.includes('\0')) {
		throw new HostMethodError('EINVAL', 'path may not contain null bytes')
	}
	const normalized = raw.startsWith('/') ? raw : `/${raw}`
	const segments = normalized.split('/').filter((s) => s.length > 0)
	for (const seg of segments) {
		if (seg === '..') throw new HostMethodError('EINVAL', 'path may not contain `..`')
	}
	return `${APP_ROOT_PREFIX}/${appId}${segments.length === 0 ? '' : `/${segments.join('/')}`}`
}

/** Volume contributions to the host RPC registry. */
export const volumeHandlers = {
	'app.volume.readText': async ({ path }, { vol, appId }) => {
		const scoped = scopeAppPath(appId, path)
		const bytes = await readOrThrow(vol, scoped)
		return new TextDecoder().decode(bytes)
	},
	'app.volume.writeText': async ({ path, data }, { vol, appId }) => {
		if (typeof data !== 'string') {
			throw new HostMethodError('EINVAL', 'data must be a string')
		}
		const scoped = scopeAppPath(appId, path)
		await ensureParent(vol, scoped)
		await vol.writeFile(scoped, new TextEncoder().encode(data))
		return null
	},
	'app.volume.readFile': async ({ path }, { vol, appId }) => {
		const scoped = scopeAppPath(appId, path)
		const bytes = await readOrThrow(vol, scoped)
		return uint8ToBase64(bytes)
	},
	'app.volume.writeFile': async ({ path, bytes }, { vol, appId }) => {
		if (typeof bytes !== 'string') {
			throw new HostMethodError('EINVAL', 'bytes must be a base64-encoded string')
		}
		let decoded: Uint8Array
		try {
			decoded = base64ToUint8(bytes)
		} catch {
			throw new HostMethodError('EINVAL', 'bytes is not valid base64')
		}
		const scoped = scopeAppPath(appId, path)
		await ensureParent(vol, scoped)
		await vol.writeFile(scoped, decoded)
		return null
	}
} satisfies Pick<
	HostHandlers,
	'app.volume.readText' | 'app.volume.writeText' | 'app.volume.readFile' | 'app.volume.writeFile'
>

async function readOrThrow(vol: Volume, path: string): Promise<Uint8Array> {
	try {
		return await vol.readFile(path)
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		if (msg.startsWith('ENOENT')) throw new HostMethodError('ENOENT', `no such file: ${path}`)
		if (msg.startsWith('EISDIR')) throw new HostMethodError('EISDIR', `is a directory: ${path}`)
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

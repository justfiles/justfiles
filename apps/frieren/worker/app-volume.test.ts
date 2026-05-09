// Behavior tests for the app-volume bridge. `executeVolumeOp` is the host
// hop a `app.volume.*` JSON-RPC frame goes through: it scopes the path to
// `/apps/<appId>/`, validates payload shape, and translates Volume errors
// to stable codes.

import { expect, test } from 'bun:test'
import { volume as makeVolume, type Volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { executeVolumeOp, scopeAppPath, VolumeError } from './app-volume'

function freshVolume(): Volume {
	return makeVolume(memStorage())
}

test('scopeAppPath rewrites under /apps/<appId>', () => {
	expect(scopeAppPath('hello', 'note.txt')).toBe('/apps/hello/note.txt')
	expect(scopeAppPath('hello', '/note.txt')).toBe('/apps/hello/note.txt')
	expect(scopeAppPath('hello', '/nested/dir/file.bin')).toBe('/apps/hello/nested/dir/file.bin')
})

test('scopeAppPath collapses redundant slashes', () => {
	expect(scopeAppPath('hello', '//a///b/c')).toBe('/apps/hello/a/b/c')
})

test('scopeAppPath rejects `..` traversal', () => {
	expect(() => scopeAppPath('hello', '../escape')).toThrow(VolumeError)
	expect(() => scopeAppPath('hello', '/safe/../still-safe')).toThrow(VolumeError)
})

test('scopeAppPath rejects empty/non-string paths', () => {
	expect(() => scopeAppPath('hello', '')).toThrow(VolumeError)
	expect(() => scopeAppPath('hello', null as unknown as string)).toThrow(VolumeError)
	expect(() => scopeAppPath('hello', 42 as unknown as string)).toThrow(VolumeError)
})

test('writeText then readText round-trips text in app-private scope', async () => {
	const vol = freshVolume()
	await executeVolumeOp(vol, 'hello', {
		method: 'app.volume.writeText',
		params: { path: 'note.txt', data: 'first write' }
	})
	const result = await executeVolumeOp(vol, 'hello', {
		method: 'app.volume.readText',
		params: { path: 'note.txt' }
	})
	expect(result).toBe('first write')
	// Path actually landed under /apps/hello/
	expect(new TextDecoder().decode(await vol.readFile('/apps/hello/note.txt'))).toBe('first write')
})

test('writeText auto-creates parent directories', async () => {
	const vol = freshVolume()
	await executeVolumeOp(vol, 'hello', {
		method: 'app.volume.writeText',
		params: { path: 'deep/nested/dir/note.md', data: 'hi' }
	})
	expect(await vol.exists('/apps/hello/deep/nested/dir/note.md')).toBe(true)
})

test('readText on a missing file rejects with stable ENOENT message', async () => {
	const vol = freshVolume()
	await expect(
		executeVolumeOp(vol, 'hello', {
			method: 'app.volume.readText',
			params: { path: 'missing.txt' }
		})
	).rejects.toThrow(/^ENOENT:/)
})

test('writeFile + readFile round-trips arbitrary bytes via base64', async () => {
	const vol = freshVolume()
	const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255])
	const b64 = bytesToBase64(bytes)
	await executeVolumeOp(vol, 'hello', {
		method: 'app.volume.writeFile',
		params: { path: 'blob.bin', bytes: b64 }
	})
	const result = await executeVolumeOp(vol, 'hello', {
		method: 'app.volume.readFile',
		params: { path: 'blob.bin' }
	})
	expect(typeof result).toBe('string')
	expect(Array.from(base64ToBytes(result as string))).toEqual(Array.from(bytes))
})

test('writeFile rejects payloads that are not strings', async () => {
	const vol = freshVolume()
	await expect(
		executeVolumeOp(vol, 'hello', {
			method: 'app.volume.writeFile',
			params: { path: 'blob.bin', bytes: 123 as unknown as string }
		})
	).rejects.toThrow(/^EINVAL:/)
})

test('writeText rejects payloads that are not strings', async () => {
	const vol = freshVolume()
	await expect(
		executeVolumeOp(vol, 'hello', {
			method: 'app.volume.writeText',
			params: { path: 'note.txt', data: 42 as unknown as string }
		})
	).rejects.toThrow(/^EINVAL:/)
})

test('two apps cannot read each other through the bridge', async () => {
	const vol = freshVolume()
	await executeVolumeOp(vol, 'alpha', {
		method: 'app.volume.writeText',
		params: { path: 'secret.txt', data: 'alpha-only' }
	})
	// `beta` reads what it thinks is `secret.txt` — gets ENOENT because
	// scope rewrites to /apps/beta/secret.txt.
	await expect(
		executeVolumeOp(vol, 'beta', {
			method: 'app.volume.readText',
			params: { path: 'secret.txt' }
		})
	).rejects.toThrow(/^ENOENT:/)
	// And cannot escape upward to alpha's storage.
	await expect(
		executeVolumeOp(vol, 'beta', {
			method: 'app.volume.readText',
			params: { path: '../alpha/secret.txt' }
		})
	).rejects.toThrow(/EINVAL/)
})

test('unknown method returns EMETHOD error', async () => {
	const vol = freshVolume()
	await expect(
		executeVolumeOp(vol, 'hello', {
			method: 'app.volume.bogus',
			params: { path: 'x' }
		})
	).rejects.toThrow(/^EMETHOD:/)
})

function bytesToBase64(bytes: Uint8Array): string {
	let str = ''
	for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i] ?? 0)
	return btoa(str)
}

function base64ToBytes(b64: string): Uint8Array {
	const str = atob(b64)
	const out = new Uint8Array(str.length)
	for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i)
	return out
}

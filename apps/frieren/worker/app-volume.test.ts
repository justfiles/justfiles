// Behavior tests for the volume contributions to the host RPC pipe.
// We test each handler directly and the generic dispatcher with the
// volume registry mounted.

import { expect, test } from 'bun:test'
import { volume as makeVolume, type Volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { dispatchHostRpc, type HostHandlers, HostMethodError } from './app-host'
import { scopeAppPath, volumeHandlers } from './app-volume'

function freshVolume(): Volume {
	return makeVolume(memStorage())
}

function ctx(vol: Volume, appId = 'hello') {
	return { vol, appId }
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
	expect(() => scopeAppPath('hello', '../escape')).toThrow(HostMethodError)
	expect(() => scopeAppPath('hello', '/safe/../still-safe')).toThrow(HostMethodError)
})

test('scopeAppPath rejects empty/non-string paths', () => {
	expect(() => scopeAppPath('hello', '')).toThrow(HostMethodError)
	expect(() => scopeAppPath('hello', null as unknown as string)).toThrow(HostMethodError)
	expect(() => scopeAppPath('hello', 42 as unknown as string)).toThrow(HostMethodError)
})

test('writeText then readText round-trips text in app-private scope', async () => {
	const vol = freshVolume()
	await volumeHandlers['app.volume.writeText']({ path: 'note.txt', data: 'first write' }, ctx(vol))
	const result = await volumeHandlers['app.volume.readText']({ path: 'note.txt' }, ctx(vol))
	expect(result).toBe('first write')
	expect(new TextDecoder().decode(await vol.readFile('/apps/hello/note.txt'))).toBe('first write')
})

test('writeText auto-creates parent directories', async () => {
	const vol = freshVolume()
	await volumeHandlers['app.volume.writeText'](
		{ path: 'deep/nested/dir/note.md', data: 'hi' },
		ctx(vol)
	)
	expect(await vol.exists('/apps/hello/deep/nested/dir/note.md')).toBe(true)
})

test('readText on a missing file rejects with stable ENOENT message', async () => {
	const vol = freshVolume()
	await expect(
		volumeHandlers['app.volume.readText']({ path: 'missing.txt' }, ctx(vol))
	).rejects.toThrow(/^ENOENT:/)
})

test('writeFile + readFile round-trips arbitrary bytes via base64', async () => {
	const vol = freshVolume()
	const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255])
	await volumeHandlers['app.volume.writeFile'](
		{ path: 'blob.bin', bytes: bytesToBase64(bytes) },
		ctx(vol)
	)
	const result = await volumeHandlers['app.volume.readFile']({ path: 'blob.bin' }, ctx(vol))
	expect(typeof result).toBe('string')
	expect(Array.from(base64ToBytes(result))).toEqual(Array.from(bytes))
})

test('writeFile rejects payloads that are not strings', async () => {
	const vol = freshVolume()
	await expect(
		volumeHandlers['app.volume.writeFile'](
			{ path: 'blob.bin', bytes: 123 as unknown as string },
			ctx(vol)
		)
	).rejects.toThrow(/^EINVAL:/)
})

test('writeText rejects payloads that are not strings', async () => {
	const vol = freshVolume()
	await expect(
		volumeHandlers['app.volume.writeText'](
			{ path: 'note.txt', data: 42 as unknown as string },
			ctx(vol)
		)
	).rejects.toThrow(/^EINVAL:/)
})

test('two apps cannot read each other through the bridge', async () => {
	const vol = freshVolume()
	await volumeHandlers['app.volume.writeText'](
		{ path: 'secret.txt', data: 'alpha-only' },
		ctx(vol, 'alpha')
	)
	await expect(
		volumeHandlers['app.volume.readText']({ path: 'secret.txt' }, ctx(vol, 'beta'))
	).rejects.toThrow(/^ENOENT:/)
	await expect(
		volumeHandlers['app.volume.readText']({ path: '../alpha/secret.txt' }, ctx(vol, 'beta'))
	).rejects.toThrow(/EINVAL/)
})

// ── generic dispatcher ──────────────────────────────────────────────

test('dispatchHostRpc routes to the registered handler', async () => {
	const vol = freshVolume()
	const registry: HostHandlers = { ...volumeHandlers }
	await dispatchHostRpc(
		registry,
		'app.volume.writeText',
		{ path: 'a.txt', data: 'via dispatch' },
		ctx(vol)
	)
	const result = await dispatchHostRpc(registry, 'app.volume.readText', { path: 'a.txt' }, ctx(vol))
	expect(result).toBe('via dispatch')
})

test('dispatchHostRpc rejects unknown methods with EMETHOD', async () => {
	const vol = freshVolume()
	const registry: HostHandlers = { ...volumeHandlers }
	await expect(
		dispatchHostRpc(registry, 'app.bogus.method', { path: 'x' }, ctx(vol))
	).rejects.toThrow(/^EMETHOD:/)
})

test('dispatchHostRpc surfaces handler errors verbatim', async () => {
	const vol = freshVolume()
	const registry: HostHandlers = { ...volumeHandlers }
	await expect(
		dispatchHostRpc(registry, 'app.volume.readText', { path: 'missing.txt' }, ctx(vol))
	).rejects.toThrow(/^ENOENT:/)
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

import type { CapabilityCall } from '@justfiles/app/capabilities'
import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { expect, test } from 'vitest'
import { onlineVolumeCapability } from './online-volume'

const enc = new TextEncoder()
const dec = new TextDecoder()

const call = (
	method: string,
	args: unknown[],
	input: Partial<CapabilityCall> = {}
): CapabilityCall => ({
	appId: 'alice.notes',
	capability: 'volume',
	method,
	args,
	scopes: ['app'],
	...input
})

test('the online app volume is chrooted to its Frieren app data', async () => {
	const fs = volume(memStore())
	const cap = onlineVolumeCapability(fs, 'alice.notes', [['app']])

	await cap.invoke(call('writeFile', ['/note.txt', enc.encode('online')]))

	expect(dec.decode(await fs.readFile('/data/alice.notes/note.txt'))).toBe('online')
	expect(await fs.exists('/note.txt')).toBe(false)
})

test('the online host checks the reducer scopes against the release', async () => {
	const fs = volume(memStore())
	const cap = onlineVolumeCapability(fs, 'alice.notes', [['app']])

	await expect(
		cap.invoke(call('readFile', ['/note.txt'], { scopes: ['system'] }))
	).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
	await expect(
		onlineVolumeCapability(fs, 'alice.notes', [['/shared']]).invoke(
			call('readFile', ['/note.txt'], { scopes: ['/shared'] })
		)
	).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
})

test('only Files can use an approved system volume', async () => {
	const fs = volume(memStore())
	await fs.writeFile('/root.txt', enc.encode('root'))

	const files = onlineVolumeCapability(fs, 'justfiles.files', [['system']])
	expect(
		dec.decode(
			(await files.invoke(
				call('readFile', ['/root.txt'], {
					appId: 'justfiles.files',
					scopes: ['system']
				})
			)) as Uint8Array
		)
	).toBe('root')

	await expect(
		onlineVolumeCapability(fs, 'alice.notes', [['system']]).invoke(
			call('readFile', ['/root.txt'], { scopes: ['system'] })
		)
	).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
})

test('online volume.watch is unavailable and never polls the Store feed', async () => {
	const store = memStore()
	let polls = 0
	const fs = volume({
		...store,
		async since(cursor) {
			polls++
			return store.since(cursor)
		}
	})
	const cap = onlineVolumeCapability(fs, 'alice.notes', [['app']])

	await expect(
		cap.subscribe(call('watch', [{ path: '/', recursive: true }]), () => {})
	).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
	expect(polls).toBe(0)
})

import type { Kernel } from '@justfiles/app'
import { memStorage, volume } from '@justfiles/fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	beginInstall,
	endInstall,
	getInstalling,
	readInstallMarkers,
	seedInstalling,
	subscribeInstalling
} from './installing'
import { resumePendingInstalls } from './manage'

const fresh = () => volume(memStorage())

beforeEach(() => seedInstalling([]))

describe('installing store + fs markers', () => {
	it('beginInstall shows a tile and persists a marker; endInstall clears both', async () => {
		const fs = fresh()
		const app = { id: 'com.example.notes', name: 'Notes', iconUrl: 'x' }
		await beginInstall(fs, app)
		expect(getInstalling()).toEqual([app])
		expect(await readInstallMarkers(fs)).toEqual([app])

		await endInstall(fs, app.id)
		expect(getInstalling()).toEqual([])
		expect(await readInstallMarkers(fs)).toEqual([])
	})

	it('notifies subscribers on begin/end (with an initial replay)', async () => {
		const fs = fresh()
		const seen: number[] = []
		const off = subscribeInstalling((apps) => seen.push(apps.length))
		await beginInstall(fs, { id: 'a', name: 'A' })
		await endInstall(fs, 'a')
		off()
		expect(seen).toEqual([0, 1, 0])
	})
})

describe('resumePendingInstalls', () => {
	it('clears the marker for an app that already landed, without re-downloading', async () => {
		const fs = fresh()
		await beginInstall(fs, { id: 'com.example.notes', name: 'Notes' })
		// Simulate a crash after the bundle swapped in but before the marker cleared:
		// the kernel already lists it, so resume must NOT re-install — just tidy up.
		const kernel = { list: async () => [{ id: 'com.example.notes' }] } as unknown as Kernel
		let changed = 0
		await resumePendingInstalls(kernel, fs, () => {
			changed++
		})
		expect(await readInstallMarkers(fs)).toEqual([])
		expect(getInstalling()).toEqual([])
		expect(changed).toBe(1)
	})
})

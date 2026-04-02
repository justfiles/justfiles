import { afterEach, describe, expect, mock, test } from 'bun:test'

import { cachedStorage } from './storage.cached.ts'
import { memStorage } from './storage.mem.ts'
import { FileType } from './types.ts'
import { GHOSTORE_XATTR, decodeXattr, encodeXattr } from './xattr.ts'

const storages = []

afterEach(() => {
	for (const storage of storages.splice(0)) {
		storage.destroy()
	}
})

async function waitFor(check, timeoutMs = 250) {
	const startedAt = Date.now()
	for (;;) {
		if (await check()) return
		if (Date.now() - startedAt >= timeoutMs) {
			throw new Error('Timed out waiting for async condition')
		}
		await Bun.sleep(5)
	}
}

function buildRemoteWithUpdates(ops) {
	const remote = memStorage()
	let sent = false
	remote.updates = mock(async (cursor, options) => {
		const filteredOps = options?.source && options?.sourceMode === 'exclude'
			? ops.filter((op) => op.source !== options.source)
			: ops
		if (!sent && cursor === '') {
			sent = true
			return { ops: filteredOps, cursor: '1' }
		}
		return { ops: [], cursor: sent ? '1' : cursor }
	})
	return remote
}

function attachXattrOpLog(storage) {
	const pendingOps = []

	const originalSetXattr = storage.setXattr.bind(storage)
	storage.setXattr = mock(async (ino, name, value, options) => {
		await originalSetXattr(ino, name, value)
		pendingOps.push({
			kind: 'upsert-inode',
			source: options?.source,
			ino,
			xattrs: {},
		})
	})

	const originalRemoveXattr = storage.removeXattr.bind(storage)
	storage.removeXattr = mock(async (ino, name, options) => {
		await originalRemoveXattr(ino, name)
		pendingOps.push({
			kind: 'upsert-inode',
			source: options?.source,
			ino,
			xattrs: {},
		})
	})

	storage.updates = mock(async (cursor, options) => {
		const since = cursor === '' ? 0 : Number.parseInt(cursor, 10)
		const ops = pendingOps
			.slice(Number.isFinite(since) ? since : 0)
			.filter((op) => {
				if (!options?.source) return true
				return options.sourceMode === 'exclude' ? op.source !== options.source : op.source === options.source
			})
		return {
			ops,
			cursor: String(pendingOps.length),
		}
	})

	return pendingOps
}

function attachContentOpLog(storage) {
	const pendingOps = []

	const originalWrite = storage.write.bind(storage)
	storage.write = mock(async (ino, offset, chunk, options) => {
		const written = await originalWrite(ino, offset, chunk)
		pendingOps.push({
			kind: 'upsert-inode',
			source: options?.source,
			ino,
			contentChanged: true,
		})
		return written
	})

	const originalTruncate = storage.truncate.bind(storage)
	storage.truncate = mock(async (ino, size, options) => {
		await originalTruncate(ino, size)
		pendingOps.push({
			kind: 'upsert-inode',
			source: options?.source,
			ino,
			contentChanged: true,
		})
	})

	storage.updates = mock(async (cursor, options) => {
		const since = cursor === '' ? 0 : Number.parseInt(cursor, 10)
		const ops = pendingOps
			.slice(Number.isFinite(since) ? since : 0)
			.filter((op) => {
				if (!options?.source) return true
				return options.sourceMode === 'exclude' ? op.source !== options.source : op.source === options.source
			})
		return {
			ops,
			cursor: String(pendingOps.length),
		}
	})

	return pendingOps
}

describe('cachedStorage', () => {
	test('flushes legacy source-less local xattr ops', async () => {
		const local = memStorage()
		attachXattrOpLog(local)
		await local.setXattr('5', GHOSTORE_XATTR.title, encodeXattr('Legacy Local'))
		await local.write('/.state/dirty', 0n, new TextEncoder().encode('5:2'))

		const remote = buildRemoteWithUpdates([])
		const originalRemoteSetXattr = remote.setXattr.bind(remote)
		remote.setXattr = mock(async (...args) => originalRemoteSetXattr(...args))

		const storage = cachedStorage(local, remote, { clientId: 'client-a' })
		storages.push(storage)

		await waitFor(() => remote.setXattr.mock.calls.length === 1)

		expect(remote.setXattr).toHaveBeenCalledTimes(1)
		expect(remote.setXattr.mock.calls[0][0]).toBe('5')
		expect(remote.setXattr.mock.calls[0][1]).toBe(GHOSTORE_XATTR.title)
		expect(remote.setXattr.mock.calls[0][2]).toEqual(encodeXattr('Legacy Local'))
		expect(remote.setXattr.mock.calls[0][3]).toBeUndefined()
	})

	test('applies remote xattr deltas locally without replaying them on the next flush', async () => {
		const local = memStorage()
		attachXattrOpLog(local)

		const remote = buildRemoteWithUpdates([{
			kind: 'upsert-inode',
			source: 'remote-peer',
			ino: '2',
			xattrs: {
				[GHOSTORE_XATTR.title]: encodeXattr('Remote Title'),
			},
		}])
		remote.getXattr = mock(async () => {
			throw new Error('getXattr should not be needed after delta sync hydration')
		})
		const originalRemoteSetXattr = remote.setXattr.bind(remote)
		remote.setXattr = mock(async (...args) => originalRemoteSetXattr(...args))

		const storage = cachedStorage(local, remote, { clientId: 'client-a' })
		storages.push(storage)

		await waitFor(async () => (await local.getXattr('2', GHOSTORE_XATTR.title)) !== null)

		const value = await storage.getXattr('2', GHOSTORE_XATTR.title)
		await storage.setXattr('9', GHOSTORE_XATTR.title, encodeXattr('Local Title'))
		await storage.flush()

		expect(value).not.toBeNull()
		expect(decodeXattr(value)).toBe('Remote Title')
		expect(local.setXattr).toHaveBeenCalledTimes(2)
		expect(remote.getXattr).toHaveBeenCalledTimes(0)
		expect(remote.setXattr).toHaveBeenCalledTimes(1)
		expect(remote.setXattr.mock.calls[0][0]).toBe('9')
		expect(remote.setXattr.mock.calls[0][1]).toBe(GHOSTORE_XATTR.title)
		expect(remote.setXattr.mock.calls[0][2]).toEqual(encodeXattr('Local Title'))
		expect(remote.setXattr.mock.calls[0][3]).toEqual(expect.objectContaining({
			source: expect.any(String),
		}))
	})

	test('applies remote xattr removals to local cache', async () => {
		const local = memStorage()
		const originalSetXattr = local.setXattr.bind(local)
		await originalSetXattr('2', GHOSTORE_XATTR.tags, encodeXattr(['stale']))
		attachXattrOpLog(local)

		const remote = buildRemoteWithUpdates([{
			kind: 'upsert-inode',
			source: 'remote-peer',
			ino: '2',
			xattrs: {
				[GHOSTORE_XATTR.tags]: null,
			},
		}])

		const storage = cachedStorage(local, remote, { clientId: 'client-a' })
		storages.push(storage)

		await waitFor(async () => (await local.getXattr('2', GHOSTORE_XATTR.tags)) === null)

		expect(await local.getXattr('2', GHOSTORE_XATTR.tags)).toBeNull()
		expect(await storage.getXattr('2', GHOSTORE_XATTR.tags)).toBeNull()
		expect(await storage.listXattr('2')).toEqual([])
	})

	test('hydrates remote content locally without replaying it on the next flush', async () => {
		const local = memStorage()
		attachContentOpLog(local)

		const remote = buildRemoteWithUpdates([{
			kind: 'upsert-inode',
			source: 'remote-peer',
			ino: '2',
			contentChanged: true,
		}])
		await remote.alloc({
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			nlink: 0,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})
		await remote.write('2', 0n, new TextEncoder().encode('remote body'))
		const originalRemoteWrite = remote.write.bind(remote)
		remote.write = mock(async (...args) => originalRemoteWrite(...args))
		const originalRemoteTruncate = remote.truncate.bind(remote)
		remote.truncate = mock(async (...args) => originalRemoteTruncate(...args))

		const storage = cachedStorage(local, remote, { clientId: 'client-a' })
		storages.push(storage)

		await waitFor(async () => {
			const buf = await storage.read('2', 0n, 32)
			return new TextDecoder().decode(buf) === 'remote body'
		})
		await storage.flush()

		expect(new TextDecoder().decode(await storage.read('2', 0n, 32))).toBe('remote body')
		expect(remote.truncate).toHaveBeenCalledTimes(0)
		expect(remote.write).toHaveBeenCalledTimes(0)
		const hydrationCall = local.write.mock.calls.find(([ino, offset, data, options]) =>
			ino === '2' &&
			offset === 0n &&
			new TextDecoder().decode(data) === 'remote body' &&
			options?.source === 'client-a:remote'
		)
		expect(hydrationCall).toBeDefined()
	})
})

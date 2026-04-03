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

function attachDirOpLog(storage) {
	const pendingOps = []

	const originalDirAdd = storage.dirAdd.bind(storage)
	storage.dirAdd = mock(async (dirIno, name, ino, type, options) => {
		const added = await originalDirAdd(dirIno, name, ino, type)
		if (added) {
			pendingOps.push({
				kind: 'set-dirent',
				source: options?.source,
				dirIno,
				name,
				ino,
				type,
			})
		}
		return added
	})

	const originalDirSet = storage.dirSet.bind(storage)
	storage.dirSet = mock(async (dirIno, name, ino, type, options) => {
		const displaced = await originalDirSet(dirIno, name, ino, type)
		pendingOps.push({
			kind: 'set-dirent',
			source: options?.source,
			dirIno,
			name,
			ino,
			type,
		})
		return displaced
	})

	const originalDirUnset = storage.dirUnset.bind(storage)
	storage.dirUnset = mock(async (dirIno, name, options) => {
		const removed = await originalDirUnset(dirIno, name)
		if (removed !== null) {
			pendingOps.push({
				kind: 'unset-dirent',
				source: options?.source,
				dirIno,
				name,
				ino: removed.ino,
			})
		}
		return removed
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
	test('flushes pending local namespace ops before the first bootstrap', async () => {
		const local = memStorage()
		attachDirOpLog(local)
		await local.setMeta('2', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			nlink: 1,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})
		await local.dirAdd(local.rootIno, 'note.txt', '2', FileType.Regular)
		await local.dirUnset(local.rootIno, 'note.txt')
		await local.write('/.state/dirty', 0n, new TextEncoder().encode('1:4\n2:4'))

		const remote = memStorage()
		await remote.create(remote.rootIno, 'note.txt', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})

		const storage = cachedStorage(local, remote, { clientId: 'client-a' })
		storages.push(storage)

		expect(await storage.dirLookup(remote.rootIno, 'note.txt')).toBeNull()
		expect(await local.dirLookup(remote.rootIno, 'note.txt')).toBeNull()
		expect(await remote.dirLookup(remote.rootIno, 'note.txt')).toBeNull()
	})

	test('bootstraps and reconciles the local namespace on first sync', async () => {
		const local = memStorage()
		await local.setMeta('2', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			nlink: 1,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})
		await local.dirAdd(local.rootIno, 'a.txt', '2', FileType.Regular)
		await local.setMeta('99', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			nlink: 1,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})
		await local.dirAdd(local.rootIno, 'stale.txt', '99', FileType.Regular)

		const remote = memStorage()
		const aIno = await remote.create(remote.rootIno, 'a.txt', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})
		const bIno = await remote.create(remote.rootIno, 'b.txt', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})
		const originalRemoteDirList = remote.dirList.bind(remote)
		remote.dirList = mock(async (...args) => originalRemoteDirList(...args))

		const storage = cachedStorage(local, remote, { clientId: 'client-a' })
		storages.push(storage)

		const entries = await storage.dirList(remote.rootIno, '')

		expect(entries.entries).toEqual(expect.arrayContaining([
			{ name: 'a.txt', ino: aIno, type: FileType.Regular },
			{ name: 'b.txt', ino: bIno, type: FileType.Regular },
			{ name: '.state', ino: '/.state', type: FileType.Directory },
		]))
		expect(entries.entries.some((entry) => entry.name === 'stale.txt')).toBeFalse()
		expect(await local.dirLookup(remote.rootIno, 'a.txt')).toEqual({ ino: aIno, type: FileType.Regular })
		expect(await local.dirLookup(remote.rootIno, 'b.txt')).toEqual({ ino: bIno, type: FileType.Regular })
		expect(await local.dirLookup(remote.rootIno, 'stale.txt')).toBeNull()
		expect(remote.dirList).toHaveBeenCalledTimes(1)
	})

	test('uses incremental updates on subsequent startups without a full bootstrap', async () => {
		const local = memStorage()
		await local.setMeta('2', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			nlink: 1,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})
		await local.dirAdd(local.rootIno, 'existing.txt', '2', FileType.Regular)
		await local.write('/.state/syncstate', 0n, new TextEncoder().encode(JSON.stringify({
			remoteCursor: '1',
			localCursor: '',
			namespaceBootstrapped: true,
		})))

		const remote = memStorage()
		remote.dirList = mock(async () => {
			throw new Error('full bootstrap should not run after namespaceBootstrapped=true')
		})
		remote.updates = mock(async (cursor) => {
			if (cursor === '1') {
				return {
					ops: [
						{
							kind: 'upsert-inode',
							source: 'remote-peer',
							ino: '3',
							meta: {
								type: FileType.Regular,
								size: 0n,
								mode: 0o644,
								nlink: 1,
								mtimeNs: 0n,
								ctimeNs: 0n,
							},
						},
						{
							kind: 'set-dirent',
							source: 'remote-peer',
							dirIno: '1',
							name: 'new.txt',
							ino: '3',
							type: FileType.Regular,
						},
					],
					cursor: '2',
				}
			}
			return { ops: [], cursor }
		})

		const storage = cachedStorage(local, remote, { clientId: 'client-a' })
		storages.push(storage)

		expect(await storage.dirLookup(remote.rootIno, 'existing.txt')).toEqual({
			ino: '2',
			type: FileType.Regular,
		})
		await waitFor(async () => (await storage.dirLookup(remote.rootIno, 'new.txt')) !== null)

		expect(await storage.dirLookup(remote.rootIno, 'new.txt')).toEqual({
			ino: '3',
			type: FileType.Regular,
		})
		expect(remote.dirList).toHaveBeenCalledTimes(0)
		expect(remote.updates).toHaveBeenCalled()
	})

	test('does not resurrect a locally deleted entry before flush', async () => {
		const local = memStorage()
		attachDirOpLog(local)

		const remote = memStorage()
		const ino = await remote.create(remote.rootIno, 'note.txt', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})
		const originalRemoteDirSet = remote.dirSet.bind(remote)
		remote.dirSet = mock(async (...args) => originalRemoteDirSet(...args))
		const originalRemoteDirUnset = remote.dirUnset.bind(remote)
		remote.dirUnset = mock(async (...args) => originalRemoteDirUnset(...args))
		remote.rename = mock(async () => {
			throw new Error('cachedStorage should flush local rename via dirSet/dirUnset, not remote.rename')
		})

		const storage = cachedStorage(local, remote, {
			clientId: 'client-a',
			flushDebounceMs: 60_000,
		})
		storages.push(storage)

		expect(await storage.dirLookup(remote.rootIno, 'note.txt')).toEqual({ ino, type: FileType.Regular })

		await storage.dirUnset(remote.rootIno, 'note.txt')

		expect(await local.dirLookup(remote.rootIno, 'note.txt')).toBeNull()
		expect(await storage.dirLookup(remote.rootIno, 'note.txt')).toBeNull()
		expect(await remote.dirLookup(remote.rootIno, 'note.txt')).toEqual({ ino, type: FileType.Regular })
		expect(remote.rename).toHaveBeenCalledTimes(0)
	})

	test('applies remote directory deltas locally without replaying them on flush', async () => {
		const local = memStorage()
		attachDirOpLog(local)

		const remote = buildRemoteWithUpdates([
			{
				kind: 'upsert-inode',
				source: 'remote-peer',
				ino: '2',
				meta: {
					type: FileType.Regular,
					size: 0n,
					mode: 0o644,
					nlink: 1,
					mtimeNs: 0n,
					ctimeNs: 0n,
				},
			},
			{
				kind: 'set-dirent',
				source: 'remote-peer',
				dirIno: '1',
				name: 'remote.txt',
				ino: '2',
				type: FileType.Regular,
			},
		])
		remote.dirLookup = mock(async () => {
			throw new Error('dirLookup should not be needed after remote dir delta hydration')
		})
		const originalRemoteDirSet = remote.dirSet.bind(remote)
		remote.dirSet = mock(async (...args) => originalRemoteDirSet(...args))

		const storage = cachedStorage(local, remote, { clientId: 'client-a' })
		storages.push(storage)

		await waitFor(async () => (await local.dirLookup(remote.rootIno, 'remote.txt')) !== null)
		await storage.flush()

		expect(await storage.dirLookup(remote.rootIno, 'remote.txt')).toEqual({
			ino: '2',
			type: FileType.Regular,
		})
		expect(await storage.getMeta('2')).toEqual(expect.objectContaining({
			type: FileType.Regular,
			mode: 0o644,
		}))
		expect(remote.dirLookup).toHaveBeenCalledTimes(0)
		expect(remote.dirSet).toHaveBeenCalledTimes(0)
	})

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

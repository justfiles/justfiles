import { describe, expect, mock, test } from 'bun:test'

import { fs } from './fs.ts'
import { FileType, OpenFlags } from './types.ts'
import { decodeXattr, encodeXattr } from './xattr.ts'

function meta(overrides = {}) {
	return {
		type: FileType.Regular,
		size: 0n,
		mode: 0o644,
		nlink: 1,
		mtimeNs: 10n,
		ctimeNs: 20n,
		...overrides,
	}
}

function backend(overrides = {}) {
	return {
		alloc: mock(async () => '100'),
		getMeta: mock(async () => null),
		setMeta: mock(async () => {}),
		read: mock(async () => new Uint8Array()),
		write: mock(async (_ino, _offset, data) => data.length),
		truncate: mock(async () => {}),
		dirLookup: mock(async () => null),
		dirList: mock(async () => ({ entries: [], next: '' })),
		dirAdd: mock(async () => true),
		dirSet: mock(async () => null),
		dirUnset: mock(async () => null),
		...overrides,
	}
}

function bytes(text) {
	return new TextEncoder().encode(text)
}

async function expectRejects(action, message) {
	let error
	try {
		await action()
	} catch (caught) {
		error = caught
	}
	if (error === undefined) {
		throw new Error('Expected promise to reject')
	}
	if (message !== undefined) {
		expect(error instanceof Error ? error.message : String(error)).toContain(message)
	}
}

describe('fs', () => {
	test('maps backend metadata to stat and reuses the metadata cache for open', async () => {
		const storage = backend({
			getMeta: mock(async (ino) => {
				expect(ino).toBe('7')
				return meta({
					type: FileType.Regular,
					size: 5n,
					mode: 0o600,
					nlink: 2,
					mtimeNs: 111n,
					ctimeNs: 222n,
					contentHash: 'abc123',
				})
			}),
		})
		const vfs = fs(storage)

		expect(await vfs.stat('7')).toEqual({
			ino: '7',
			type: FileType.Regular,
			size: 5n,
			mode: 0o600,
			nlink: 2,
			mtimeNs: 111n,
			ctimeNs: 222n,
			contentHash: 'abc123',
		})

		const fd = await vfs.open('7', OpenFlags.Read)

		expect(typeof fd).toBe('number')
		expect(storage.getMeta).toHaveBeenCalledTimes(1)
	})

	test('caches both positive and negative directory lookups', async () => {
		const storage = backend({
			dirLookup: mock(async (_dirIno, name) => {
				if (name === 'alpha') return { ino: '9', type: FileType.Regular }
				return null
			}),
		})
		const vfs = fs(storage)

		expect(await vfs.lookup('1', 'alpha')).toBe('9')
		expect(await vfs.lookup('1', 'alpha')).toBe('9')
		expect(await vfs.lookup('1', 'missing')).toBeNull()
		expect(await vfs.lookup('1', 'missing')).toBeNull()

		expect(storage.dirLookup).toHaveBeenCalledTimes(2)
		expect(storage.dirLookup).toHaveBeenNthCalledWith(1, '1', 'alpha')
		expect(storage.dirLookup).toHaveBeenNthCalledWith(2, '1', 'missing')
	})

	test('passes readdir through to the backend cursor API', async () => {
		const storage = backend({
			dirList: mock(async (dirIno, cursor) => {
				expect(dirIno).toBe('3')
				expect(cursor).toBe('page-1')
				return {
					entries: [
						{ ino: '4', name: 'notes.md', type: FileType.Regular },
						{ ino: '5', name: 'docs', type: FileType.Directory },
					],
					next: 'page-2',
				}
			}),
		})
		const vfs = fs(storage)

		expect(await vfs.readdir('3', 'page-1')).toEqual({
			entries: [
				{ ino: '4', name: 'notes.md', type: FileType.Regular },
				{ ino: '5', name: 'docs', type: FileType.Directory },
			],
			next: 'page-2',
		})
	})

	test('delegates xattr operations to the backend when supported', async () => {
		const storage = backend({
			getXattr: mock(async (ino, name) => {
				expect(ino).toBe('7')
				expect(name).toBe('ghostore.tags')
				return encodeXattr(['context'])
			}),
			setXattr: mock(async (ino, name, value) => {
				expect(ino).toBe('7')
				expect(name).toBe('ghostore.tags')
				expect(decodeXattr(value)).toEqual(['context', 'task'])
			}),
			listXattr: mock(async (ino) => {
				expect(ino).toBe('7')
				return ['ghostore.tags', 'ghostore.title']
			}),
			removeXattr: mock(async (ino, name) => {
				expect(ino).toBe('7')
				expect(name).toBe('ghostore.title')
			}),
		})
		const vfs = fs(storage)

		expect(decodeXattr(await vfs.getXattr('7', 'ghostore.tags'))).toEqual(['context'])
		await vfs.setXattr('7', 'ghostore.tags', encodeXattr(['context', 'task']))
		expect(await vfs.listXattr('7')).toEqual(['ghostore.tags', 'ghostore.title'])
		await vfs.removeXattr('7', 'ghostore.title')

		expect(storage.getXattr).toHaveBeenCalledTimes(1)
		expect(storage.setXattr).toHaveBeenCalledTimes(1)
		expect(storage.listXattr).toHaveBeenCalledTimes(1)
		expect(storage.removeXattr).toHaveBeenCalledTimes(1)
	})

	test('treats missing backend xattr support as empty and silent', async () => {
		const storage = backend()
		delete storage.getXattr
		delete storage.setXattr
		delete storage.listXattr
		delete storage.removeXattr
		const vfs = fs(storage)

		expect(await vfs.getXattr('7', 'ghostore.tags')).toBeNull()
		expect(await vfs.listXattr('7')).toEqual([])
		await expect(vfs.setXattr('7', 'ghostore.tags', encodeXattr(['context']))).resolves.toBeUndefined()
		await expect(vfs.removeXattr('7', 'ghostore.tags')).resolves.toBeUndefined()
	})

	test('uses backend.create when available for mknod', async () => {
		const storage = backend({
			create: mock(async (dirIno, name, initialMeta) => {
				expect(dirIno).toBe('1')
				expect(name).toBe('draft.md')
				expect(initialMeta).toEqual({
					type: FileType.Regular,
					size: 0n,
					mode: 0o644,
					mtimeNs: expect.anything(),
					ctimeNs: expect.anything(),
				})
				return '12'
			}),
		})
		const vfs = fs(storage)

		expect(await vfs.mknod('1', 'draft.md', FileType.Regular, 0o644)).toBe('12')

		expect(storage.create).toHaveBeenCalledTimes(1)
		expect(storage.alloc).not.toHaveBeenCalled()
		expect(storage.dirAdd).not.toHaveBeenCalled()
	})

	test('falls back to alloc plus dirAdd when create is unavailable', async () => {
		const storage = backend({
			alloc: mock(async (initialMeta) => {
				expect(initialMeta).toEqual({
					type: FileType.Directory,
					size: 0n,
					mode: 0o755,
					mtimeNs: expect.anything(),
					ctimeNs: expect.anything(),
				})
				return '15'
			}),
			dirAdd: mock(async (dirIno, name, ino, type) => {
				expect(dirIno).toBe('2')
				expect(name).toBe('workspace')
				expect(ino).toBe('15')
				expect(type).toBe(FileType.Directory)
				return true
			}),
		})
		delete storage.create
		const vfs = fs(storage)

		expect(await vfs.mknod('2', 'workspace', FileType.Directory, 0o755)).toBe('15')

		expect(storage.alloc).toHaveBeenCalledTimes(1)
		expect(storage.dirAdd).toHaveBeenCalledTimes(1)
	})

	test('maps dirAdd conflicts to an error for mknod', async () => {
		const storage = backend({
			alloc: mock(async () => '21'),
			dirAdd: mock(async () => false),
		})
		delete storage.create
		const vfs = fs(storage)

		await expectRejects(() => vfs.mknod('2', 'dupe', FileType.Regular, 0o644))

		expect(storage.alloc).toHaveBeenCalledTimes(1)
		expect(storage.dirAdd).toHaveBeenCalledTimes(1)
	})

	test('uses a cached stat to resolve the target type for hard links', async () => {
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Regular, size: 99n })),
			dirAdd: mock(async (dirIno, name, ino, type) => {
				expect(dirIno).toBe('1')
				expect(name).toBe('copy.md')
				expect(ino).toBe('8')
				expect(type).toBe(FileType.Regular)
				return true
			}),
		})
		const vfs = fs(storage)

		await vfs.stat('8')
		expect(await vfs.link('1', 'copy.md', '8')).toBeUndefined()

		expect(storage.getMeta).toHaveBeenCalledTimes(1)
		expect(storage.dirAdd).toHaveBeenCalledTimes(1)
	})

	test('invalidates cached target metadata after link updates nlink', async () => {
		let nlink = 1
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Regular, nlink })),
			dirAdd: mock(async () => {
				nlink = 2
				return true
			}),
		})
		const vfs = fs(storage)

		expect(await vfs.stat('8')).toEqual(expect.objectContaining({ nlink: 1 }))
		expect(await vfs.link('1', 'copy.md', '8')).toBeUndefined()
		expect(await vfs.stat('8')).toEqual(expect.objectContaining({ nlink: 2 }))

		expect(storage.getMeta).toHaveBeenCalledTimes(2)
	})

	test('rejects hard links to directories before touching dirAdd', async () => {
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Directory })),
		})
		const vfs = fs(storage)

		await expectRejects(() => vfs.link('1', 'dir-link', '4'))

		expect(storage.dirAdd).not.toHaveBeenCalled()
	})

	test('truncates on open when the write-truncate flag is used', async () => {
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Regular, size: 12n })),
		})
		const vfs = fs(storage)

		await vfs.open('6', OpenFlags.Write | OpenFlags.Trunc)

		expect(storage.getMeta).toHaveBeenCalledTimes(1)
		expect(storage.truncate).toHaveBeenCalledTimes(1)
		expect(storage.truncate).toHaveBeenCalledWith('6', 0n)
	})

	test('rejects reading from a write-only fd', async () => {
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Regular, size: 3n })),
		})
		const vfs = fs(storage)
		const fd = await vfs.open('90', OpenFlags.Write)

		await expectRejects(() => vfs.pread(fd, new Uint8Array(1), 0n))
		expect(storage.read).not.toHaveBeenCalled()
	})

	test('rejects writing and truncating through a read-only fd', async () => {
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Regular, size: 3n })),
		})
		const vfs = fs(storage)
		const fd = await vfs.open('91', OpenFlags.Read)

		await expectRejects(() => vfs.pwrite(fd, bytes('x'), 0n))
		await expectRejects(() => vfs.truncate(fd, 0n))

		expect(storage.write).not.toHaveBeenCalled()
		expect(storage.truncate).not.toHaveBeenCalled()
	})

	test('reads the full file into the content cache on the first pread', async () => {
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Regular, size: 5n })),
			read: mock(async (ino, offset, length) => {
				expect(ino).toBe('30')
				expect(offset).toBe(0n)
				expect(length).toBe(5)
				return bytes('hello')
			}),
		})
		const vfs = fs(storage)
		const fd = await vfs.open('30', OpenFlags.Read)

		const first = new Uint8Array(2)
		const second = new Uint8Array(3)

		expect(await vfs.pread(fd, first, 3n)).toBe(2)
		expect(await vfs.pread(fd, second, 1n)).toBe(3)

		expect(Array.from(first)).toEqual(Array.from(bytes('lo')))
		expect(Array.from(second)).toEqual(Array.from(bytes('ell')))
		expect(storage.read).toHaveBeenCalledTimes(1)
	})

	test('invalidates cached file content and metadata after pwrite', async () => {
		let metaReads = 0
		const storage = backend({
			getMeta: mock(async () => {
				metaReads += 1
				return meta({ type: FileType.Regular, size: metaReads === 1 ? 5n : 7n })
			}),
			read: mock(async () => bytes('hello!!')),
			write: mock(async (_ino, _offset, data) => data.length),
		})
		const vfs = fs(storage)
		const fd = await vfs.open('31', OpenFlags.Read | OpenFlags.Write)
		const buf = new Uint8Array(2)

		await vfs.pread(fd, buf, 0n)
		expect(await vfs.pwrite(fd, bytes('!!'), 5n)).toBe(2)
		await vfs.stat('31')
		await vfs.pread(fd, buf, 0n)

		expect(storage.write).toHaveBeenCalledTimes(1)
		expect(storage.getMeta).toHaveBeenCalledTimes(2)
		expect(storage.read).toHaveBeenCalledTimes(2)
	})

	test('uses byte length, not string length, for symlink size', async () => {
		const target = '/workspace/猫-notes'
		const storage = backend({
			create: mock(async (_dirIno, _name, initialMeta) => {
				expect(initialMeta).toEqual({
					type: FileType.Symlink,
					size: BigInt(bytes(target).length),
					mode: 0o777,
					mtimeNs: expect.anything(),
					ctimeNs: expect.anything(),
					symlinkTarget: target,
				})
				return '92'
			}),
		})
		const vfs = fs(storage)

		expect(await vfs.symlink('1', 'note-link', target)).toBe('92')
	})

	test('invalidates cached metadata after setattr', async () => {
		let mode = 0o644
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Regular, mode })),
			setMeta: mock(async (_ino, partial) => {
				expect(partial).toEqual({ mode: 0o600 })
				mode = 0o600
			}),
		})
		const vfs = fs(storage)

		expect(await vfs.stat('40')).toEqual(expect.objectContaining({ mode: 0o644 }))
		expect(await vfs.setattr('40', { mode: 0o600 })).toBeUndefined()
		expect(await vfs.stat('40')).toEqual(expect.objectContaining({ mode: 0o600 }))

		expect(storage.getMeta).toHaveBeenCalledTimes(2)
		expect(storage.setMeta).toHaveBeenCalledTimes(1)
	})

	test('invalidates cached lookup and inode metadata after unlink', async () => {
		let removed = false
		const storage = backend({
			getMeta: mock(async () => (removed ? null : meta({ type: FileType.Regular, size: 3n }))),
			dirLookup: mock(async () => (removed ? null : { ino: '50', type: FileType.Regular })),
			dirUnset: mock(async () => {
				removed = true
				return { ino: '50', type: FileType.Regular }
			}),
		})
		const vfs = fs(storage)

		expect(await vfs.lookup('2', 'gone.txt')).toBe('50')
		expect(await vfs.stat('50')).toEqual(expect.objectContaining({ ino: '50' }))
		expect(await vfs.unlink('2', 'gone.txt')).toBeUndefined()
		expect(await vfs.lookup('2', 'gone.txt')).toBeNull()
		await expectRejects(() => vfs.stat('50'))

		expect(storage.dirLookup).toHaveBeenCalledTimes(2)
		expect(storage.getMeta).toHaveBeenCalledTimes(2)
		expect(storage.dirUnset).toHaveBeenCalledTimes(1)
	})

	test('uses backend.rename when the backend provides an atomic rename primitive', async () => {
		const storage = backend({
			rename: mock(async (oldDir, oldName, newDir, newName) => {
				expect(oldDir).toBe('1')
				expect(oldName).toBe('old.txt')
				expect(newDir).toBe('2')
				expect(newName).toBe('new.txt')
				return null
			}),
		})
		const vfs = fs(storage)

		expect(await vfs.rename('1', 'old.txt', '2', 'new.txt')).toBeUndefined()

		expect(storage.rename).toHaveBeenCalledTimes(1)
		expect(storage.dirLookup).not.toHaveBeenCalled()
		expect(storage.dirSet).not.toHaveBeenCalled()
		expect(storage.dirUnset).not.toHaveBeenCalled()
	})

	test('falls back to dirLookup plus dirSet plus dirUnset for rename without extra metadata reads', async () => {
		const calls = []
		const storage = backend({
			getMeta: mock(async () => {
				throw new Error('rename fallback should not need getMeta')
			}),
			dirLookup: mock(async () => {
				calls.push('lookup')
				return { ino: '60', type: FileType.Regular }
			}),
			dirSet: mock(async () => {
				calls.push('set')
				return { ino: '61', type: FileType.Regular }
			}),
			dirUnset: mock(async () => {
				calls.push('unset')
				return { ino: '60', type: FileType.Regular }
			}),
		})
		delete storage.rename
		const vfs = fs(storage)

		expect(await vfs.rename('3', 'before.md', '4', 'after.md')).toBeUndefined()

		expect(calls).toEqual(['lookup', 'set', 'unset'])
		expect(storage.getMeta).not.toHaveBeenCalled()
		expect(storage.dirLookup).toHaveBeenCalledWith('3', 'before.md')
		expect(storage.dirSet).toHaveBeenCalledWith('4', 'after.md', '60', FileType.Regular)
		expect(storage.dirUnset).toHaveBeenCalledWith('3', 'before.md')
	})

	test('reads symlink targets from inode metadata', async () => {
		const storage = backend({
			getMeta: mock(async () =>
				meta({
					type: FileType.Symlink,
					symlinkTarget: '/workspace/notes/today.md',
				}),
			),
		})
		const vfs = fs(storage)

		expect(await vfs.readlink('70')).toBe('/workspace/notes/today.md')
	})

	test('rejects I/O on a closed file descriptor', async () => {
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Regular, size: 3n })),
			read: mock(async () => bytes('hey')),
		})
		const vfs = fs(storage)
		const fd = await vfs.open('80', OpenFlags.Read)

		await vfs.close(fd)

		await expectRejects(() => vfs.pread(fd, new Uint8Array(1), 0n))
	})
})

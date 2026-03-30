import { describe, expect, mock, test } from 'bun:test'

import { fs } from './fs.ts'
import { FileType, OpenFlags } from './types.ts'

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
		alloc: mock(async () => 100n),
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

describe('fs', () => {
	test('maps backend metadata to stat and reuses the metadata cache for open', async () => {
		const storage = backend({
			getMeta: mock(async (ino) => {
				expect(ino).toBe(7n)
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

		await expect(vfs.stat(7n)).resolves.toEqual({
			ino: 7n,
			type: FileType.Regular,
			size: 5n,
			mode: 0o600,
			nlink: 2,
			mtimeNs: 111n,
			ctimeNs: 222n,
			contentHash: 'abc123',
		})

		const fd = await vfs.open(7n, OpenFlags.Read)

		expect(typeof fd).toBe('number')
		expect(storage.getMeta).toHaveBeenCalledTimes(1)
	})

	test('caches both positive and negative directory lookups', async () => {
		const storage = backend({
			dirLookup: mock(async (_dirIno, name) => {
				if (name === 'alpha') return { ino: 9n, type: FileType.Regular }
				return null
			}),
		})
		const vfs = fs(storage)

		await expect(vfs.lookup(1n, 'alpha')).resolves.toBe(9n)
		await expect(vfs.lookup(1n, 'alpha')).resolves.toBe(9n)
		await expect(vfs.lookup(1n, 'missing')).resolves.toBeNull()
		await expect(vfs.lookup(1n, 'missing')).resolves.toBeNull()

		expect(storage.dirLookup).toHaveBeenCalledTimes(2)
		expect(storage.dirLookup).toHaveBeenNthCalledWith(1, 1n, 'alpha')
		expect(storage.dirLookup).toHaveBeenNthCalledWith(2, 1n, 'missing')
	})

	test('passes readdir through to the backend cursor API', async () => {
		const storage = backend({
			dirList: mock(async (dirIno, cursor) => {
				expect(dirIno).toBe(3n)
				expect(cursor).toBe('page-1')
				return {
					entries: [
						{ ino: 4n, name: 'notes.md', type: FileType.Regular },
						{ ino: 5n, name: 'docs', type: FileType.Directory },
					],
					next: 'page-2',
				}
			}),
		})
		const vfs = fs(storage)

		await expect(vfs.readdir(3n, 'page-1')).resolves.toEqual({
			entries: [
				{ ino: 4n, name: 'notes.md', type: FileType.Regular },
				{ ino: 5n, name: 'docs', type: FileType.Directory },
			],
			next: 'page-2',
		})
	})

	test('uses backend.create when available for mknod', async () => {
		const storage = backend({
			create: mock(async (dirIno, name, initialMeta) => {
				expect(dirIno).toBe(1n)
				expect(name).toBe('draft.md')
				expect(initialMeta).toEqual({
					type: FileType.Regular,
					size: 0n,
					mode: 0o644,
					mtimeNs: expect.anything(),
					ctimeNs: expect.anything(),
				})
				return 12n
			}),
		})
		const vfs = fs(storage)

		await expect(vfs.mknod(1n, 'draft.md', FileType.Regular, 0o644)).resolves.toBe(12n)

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
				return 15n
			}),
			dirAdd: mock(async (dirIno, name, ino, type) => {
				expect(dirIno).toBe(2n)
				expect(name).toBe('workspace')
				expect(ino).toBe(15n)
				expect(type).toBe(FileType.Directory)
				return true
			}),
		})
		delete storage.create
		const vfs = fs(storage)

		await expect(vfs.mknod(2n, 'workspace', FileType.Directory, 0o755)).resolves.toBe(15n)

		expect(storage.alloc).toHaveBeenCalledTimes(1)
		expect(storage.dirAdd).toHaveBeenCalledTimes(1)
	})

	test('maps dirAdd conflicts to an error for mknod', async () => {
		const storage = backend({
			alloc: mock(async () => 21n),
			dirAdd: mock(async () => false),
		})
		delete storage.create
		const vfs = fs(storage)

		await expect(vfs.mknod(2n, 'dupe', FileType.Regular, 0o644)).rejects.toThrow()

		expect(storage.alloc).toHaveBeenCalledTimes(1)
		expect(storage.dirAdd).toHaveBeenCalledTimes(1)
	})

	test('uses a cached stat to resolve the target type for hard links', async () => {
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Regular, size: 99n })),
			dirAdd: mock(async (dirIno, name, ino, type) => {
				expect(dirIno).toBe(1n)
				expect(name).toBe('copy.md')
				expect(ino).toBe(8n)
				expect(type).toBe(FileType.Regular)
				return true
			}),
		})
		const vfs = fs(storage)

		await vfs.stat(8n)
		await expect(vfs.link(1n, 'copy.md', 8n)).resolves.toBeUndefined()

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

		await expect(vfs.stat(8n)).resolves.toEqual(expect.objectContaining({ nlink: 1 }))
		await expect(vfs.link(1n, 'copy.md', 8n)).resolves.toBeUndefined()
		await expect(vfs.stat(8n)).resolves.toEqual(expect.objectContaining({ nlink: 2 }))

		expect(storage.getMeta).toHaveBeenCalledTimes(2)
	})

	test('rejects hard links to directories before touching dirAdd', async () => {
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Directory })),
		})
		const vfs = fs(storage)

		await expect(vfs.link(1n, 'dir-link', 4n)).rejects.toThrow()

		expect(storage.dirAdd).not.toHaveBeenCalled()
	})

	test('truncates on open when the write-truncate flag is used', async () => {
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Regular, size: 12n })),
		})
		const vfs = fs(storage)

		await vfs.open(6n, OpenFlags.Write | OpenFlags.Trunc)

		expect(storage.getMeta).toHaveBeenCalledTimes(1)
		expect(storage.truncate).toHaveBeenCalledTimes(1)
		expect(storage.truncate).toHaveBeenCalledWith(6n, 0n)
	})

	test('rejects reading from a write-only fd', async () => {
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Regular, size: 3n })),
		})
		const vfs = fs(storage)
		const fd = await vfs.open(90n, OpenFlags.Write)

		await expect(vfs.pread(fd, new Uint8Array(1), 0n)).rejects.toThrow()
		expect(storage.read).not.toHaveBeenCalled()
	})

	test('rejects writing and truncating through a read-only fd', async () => {
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Regular, size: 3n })),
		})
		const vfs = fs(storage)
		const fd = await vfs.open(91n, OpenFlags.Read)

		await expect(vfs.pwrite(fd, bytes('x'), 0n)).rejects.toThrow()
		await expect(vfs.truncate(fd, 0n)).rejects.toThrow()

		expect(storage.write).not.toHaveBeenCalled()
		expect(storage.truncate).not.toHaveBeenCalled()
	})

	test('reads the full file into the content cache on the first pread', async () => {
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Regular, size: 5n })),
			read: mock(async (ino, offset, length) => {
				expect(ino).toBe(30n)
				expect(offset).toBe(0n)
				expect(length).toBe(5)
				return bytes('hello')
			}),
		})
		const vfs = fs(storage)
		const fd = await vfs.open(30n, OpenFlags.Read)

		const first = new Uint8Array(2)
		const second = new Uint8Array(3)

		await expect(vfs.pread(fd, first, 3n)).resolves.toBe(2)
		await expect(vfs.pread(fd, second, 1n)).resolves.toBe(3)

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
		const fd = await vfs.open(31n, OpenFlags.Read | OpenFlags.Write)
		const buf = new Uint8Array(2)

		await vfs.pread(fd, buf, 0n)
		await expect(vfs.pwrite(fd, bytes('!!'), 5n)).resolves.toBe(2)
		await vfs.stat(31n)
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
				return 92n
			}),
		})
		const vfs = fs(storage)

		await expect(vfs.symlink(1n, 'note-link', target)).resolves.toBe(92n)
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

		await expect(vfs.stat(40n)).resolves.toEqual(expect.objectContaining({ mode: 0o644 }))
		await expect(vfs.setattr(40n, { mode: 0o600 })).resolves.toBeUndefined()
		await expect(vfs.stat(40n)).resolves.toEqual(expect.objectContaining({ mode: 0o600 }))

		expect(storage.getMeta).toHaveBeenCalledTimes(2)
		expect(storage.setMeta).toHaveBeenCalledTimes(1)
	})

	test('invalidates cached lookup and inode metadata after unlink', async () => {
		let removed = false
		const storage = backend({
			getMeta: mock(async () => (removed ? null : meta({ type: FileType.Regular, size: 3n }))),
			dirLookup: mock(async () => (removed ? null : { ino: 50n, type: FileType.Regular })),
			dirUnset: mock(async () => {
				removed = true
				return { ino: 50n, type: FileType.Regular }
			}),
		})
		const vfs = fs(storage)

		await expect(vfs.lookup(2n, 'gone.txt')).resolves.toBe(50n)
		await expect(vfs.stat(50n)).resolves.toEqual(expect.objectContaining({ ino: 50n }))
		await expect(vfs.unlink(2n, 'gone.txt')).resolves.toBeUndefined()
		await expect(vfs.lookup(2n, 'gone.txt')).resolves.toBeNull()
		await expect(vfs.stat(50n)).rejects.toThrow()

		expect(storage.dirLookup).toHaveBeenCalledTimes(2)
		expect(storage.getMeta).toHaveBeenCalledTimes(2)
		expect(storage.dirUnset).toHaveBeenCalledTimes(1)
	})

	test('uses backend.rename when the backend provides an atomic rename primitive', async () => {
		const storage = backend({
			rename: mock(async (oldDir, oldName, newDir, newName) => {
				expect(oldDir).toBe(1n)
				expect(oldName).toBe('old.txt')
				expect(newDir).toBe(2n)
				expect(newName).toBe('new.txt')
				return null
			}),
		})
		const vfs = fs(storage)

		await expect(vfs.rename(1n, 'old.txt', 2n, 'new.txt')).resolves.toBeUndefined()

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
				return { ino: 60n, type: FileType.Regular }
			}),
			dirSet: mock(async () => {
				calls.push('set')
				return { ino: 61n, type: FileType.Regular }
			}),
			dirUnset: mock(async () => {
				calls.push('unset')
				return { ino: 60n, type: FileType.Regular }
			}),
		})
		delete storage.rename
		const vfs = fs(storage)

		await expect(vfs.rename(3n, 'before.md', 4n, 'after.md')).resolves.toBeUndefined()

		expect(calls).toEqual(['lookup', 'set', 'unset'])
		expect(storage.getMeta).not.toHaveBeenCalled()
		expect(storage.dirLookup).toHaveBeenCalledWith(3n, 'before.md')
		expect(storage.dirSet).toHaveBeenCalledWith(4n, 'after.md', 60n, FileType.Regular)
		expect(storage.dirUnset).toHaveBeenCalledWith(3n, 'before.md')
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

		await expect(vfs.readlink(70n)).resolves.toBe('/workspace/notes/today.md')
	})

	test('rejects I/O on a closed file descriptor', async () => {
		const storage = backend({
			getMeta: mock(async () => meta({ type: FileType.Regular, size: 3n })),
			read: mock(async () => bytes('hey')),
		})
		const vfs = fs(storage)
		const fd = await vfs.open(80n, OpenFlags.Read)

		await vfs.close(fd)

		await expect(vfs.pread(fd, new Uint8Array(1), 0n)).rejects.toThrow()
	})
})

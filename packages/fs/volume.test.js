import { describe, expect, test } from 'bun:test'
import { memStorage } from './storage.mem.ts'
import { FileType } from './types.ts'
import { volume } from './volume.ts'
import { decodeXattr, encodeXattr, GHOSTORE_XATTR } from './xattr.ts'

function makeVol() {
	return volume(memStorage())
}

function bytes(str) {
	return new TextEncoder().encode(str)
}

function str(data) {
	return new TextDecoder().decode(data)
}

describe('volume', () => {
	describe('writeFile / readFile', () => {
		test('round-trips file content', async () => {
			const vol = makeVol()
			await vol.writeFile('/hello.txt', bytes('hello world'))
			expect(str(await vol.readFile('/hello.txt'))).toBe('hello world')
		})

		test('writeFile overwrites existing content', async () => {
			const vol = makeVol()
			await vol.writeFile('/f.txt', bytes('first'))
			await vol.writeFile('/f.txt', bytes('second'))
			expect(str(await vol.readFile('/f.txt'))).toBe('second')
		})

		test('writeFile truncates when new content is shorter', async () => {
			const vol = makeVol()
			await vol.writeFile('/f.txt', bytes('longer content'))
			await vol.writeFile('/f.txt', bytes('short'))
			expect(str(await vol.readFile('/f.txt'))).toBe('short')
		})

		test('readFile throws ENOENT for a missing path', async () => {
			const vol = makeVol()
			await expect(vol.readFile('/missing.txt')).rejects.toThrow('ENOENT')
		})

		test('readFile throws EISDIR for a directory', async () => {
			const vol = makeVol()
			await vol.mkdir('/dir')
			await expect(vol.readFile('/dir')).rejects.toThrow('EISDIR')
		})

		test('writeFile throws ENOENT when parent directory does not exist', async () => {
			const vol = makeVol()
			await expect(vol.writeFile('/no/such/dir/f.txt', bytes('x'))).rejects.toThrow('ENOENT')
		})

		test('writeFile throws EISDIR when the path is a directory', async () => {
			const vol = makeVol()
			await vol.mkdir('/dir')
			await expect(vol.writeFile('/dir', bytes('x'))).rejects.toThrow('EISDIR')
		})
	})

	describe('appendFile', () => {
		test('creates a new file when it does not exist', async () => {
			const vol = makeVol()
			await vol.appendFile('/log.txt', bytes('line1\n'))
			expect(str(await vol.readFile('/log.txt'))).toBe('line1\n')
		})

		test('appends to existing content without overwriting', async () => {
			const vol = makeVol()
			await vol.appendFile('/log.txt', bytes('a'))
			await vol.appendFile('/log.txt', bytes('b'))
			await vol.appendFile('/log.txt', bytes('c'))
			expect(str(await vol.readFile('/log.txt'))).toBe('abc')
		})

		test('throws ENOENT when parent directory does not exist', async () => {
			const vol = makeVol()
			await expect(vol.appendFile('/no/such/dir/f.txt', bytes('x'))).rejects.toThrow('ENOENT')
		})

		test('throws EISDIR when the path is a directory', async () => {
			const vol = makeVol()
			await vol.mkdir('/dir')
			await expect(vol.appendFile('/dir', bytes('x'))).rejects.toThrow('EISDIR')
		})
	})

	describe('mkdir', () => {
		test('creates a directory', async () => {
			const vol = makeVol()
			await vol.mkdir('/docs')
			expect((await vol.stat('/docs')).type).toBe(FileType.Directory)
		})

		test('throws EEXIST when the path already exists', async () => {
			const vol = makeVol()
			await vol.mkdir('/docs')
			await expect(vol.mkdir('/docs')).rejects.toThrow('EEXIST')
		})

		test('throws ENOENT when the parent does not exist', async () => {
			const vol = makeVol()
			await expect(vol.mkdir('/a/b/c')).rejects.toThrow('ENOENT')
		})

		test('recursive creates all missing parent directories', async () => {
			const vol = makeVol()
			await vol.mkdir('/a/b/c', { recursive: true })
			expect((await vol.stat('/a')).type).toBe(FileType.Directory)
			expect((await vol.stat('/a/b')).type).toBe(FileType.Directory)
			expect((await vol.stat('/a/b/c')).type).toBe(FileType.Directory)
		})

		test('recursive succeeds silently when directory already exists', async () => {
			const vol = makeVol()
			await vol.mkdir('/dir')
			await expect(vol.mkdir('/dir', { recursive: true })).resolves.toBeUndefined()
		})

		test('applies the mode to the created directory', async () => {
			const vol = makeVol()
			await vol.mkdir('/private', { mode: 0o700 })
			expect((await vol.stat('/private')).mode & 0o777).toBe(0o700)
		})
	})

	describe('readdir', () => {
		test('returns entries in a directory', async () => {
			const vol = makeVol()
			await vol.writeFile('/a.txt', bytes(''))
			await vol.mkdir('/sub')
			const entries = await vol.readdir('/')
			expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'sub'])
		})

		test('returns correct type per entry', async () => {
			const vol = makeVol()
			await vol.writeFile('/file.txt', bytes(''))
			await vol.mkdir('/dir')
			const byName = Object.fromEntries((await vol.readdir('/')).map((e) => [e.name, e.type]))
			expect(byName['file.txt']).toBe(FileType.Regular)
			expect(byName['dir']).toBe(FileType.Directory)
		})

		test('returns an empty array for an empty directory', async () => {
			const vol = makeVol()
			await vol.mkdir('/empty')
			expect(await vol.readdir('/empty')).toEqual([])
		})

		test('throws ENOENT for a missing path', async () => {
			const vol = makeVol()
			await expect(vol.readdir('/missing')).rejects.toThrow('ENOENT')
		})

		test('throws ENOTDIR for a file path', async () => {
			const vol = makeVol()
			await vol.writeFile('/f.txt', bytes(''))
			await expect(vol.readdir('/f.txt')).rejects.toThrow('ENOTDIR')
		})
	})

	describe('stat / lstat / exists', () => {
		test('stat returns correct type and size for a file', async () => {
			const vol = makeVol()
			await vol.writeFile('/f.txt', bytes('hello'))
			const s = await vol.stat('/f.txt')
			expect(s.type).toBe(FileType.Regular)
			expect(s.size).toBe(5n)
		})

		test('stat returns correct type for a directory', async () => {
			const vol = makeVol()
			await vol.mkdir('/dir')
			expect((await vol.stat('/dir')).type).toBe(FileType.Directory)
		})

		test('stat follows symlinks and returns the target type', async () => {
			const vol = makeVol()
			await vol.writeFile('/target.txt', bytes('data'))
			await vol.symlink('/target.txt', '/link.txt')
			expect((await vol.stat('/link.txt')).type).toBe(FileType.Regular)
		})

		test('lstat does not follow symlinks', async () => {
			const vol = makeVol()
			await vol.writeFile('/target.txt', bytes('data'))
			await vol.symlink('/target.txt', '/link.txt')
			expect((await vol.lstat('/link.txt')).type).toBe(FileType.Symlink)
		})

		test('stat throws ENOENT for a missing path', async () => {
			const vol = makeVol()
			await expect(vol.stat('/missing')).rejects.toThrow('ENOENT')
		})

		test('exists returns true for a file', async () => {
			const vol = makeVol()
			await vol.writeFile('/f.txt', bytes(''))
			expect(await vol.exists('/f.txt')).toBe(true)
		})

		test('exists returns true for a directory', async () => {
			const vol = makeVol()
			await vol.mkdir('/dir')
			expect(await vol.exists('/dir')).toBe(true)
		})

		test('exists returns true for a symlink', async () => {
			const vol = makeVol()
			await vol.symlink('/target', '/link')
			expect(await vol.exists('/link')).toBe(true)
		})

		test('exists returns false for a missing path', async () => {
			const vol = makeVol()
			expect(await vol.exists('/missing')).toBe(false)
		})

		test('exists never throws', async () => {
			const vol = makeVol()
			await expect(vol.exists('/a/b/c/d')).resolves.toBe(false)
		})
	})

	describe('xattr', () => {
		test('round-trips ghostore xattrs through the path API', async () => {
			const vol = makeVol()
			await vol.writeFile('/note.md', bytes('body'))

			await vol.setXattr('/note.md', GHOSTORE_XATTR.title, encodeXattr('My Note'))
			await vol.setXattr('/note.md', GHOSTORE_XATTR.tags, encodeXattr(['fs', 'xattr']))
			await vol.setXattr(
				'/note.md',
				GHOSTORE_XATTR.links,
				encodeXattr([{ rel: 'related', path: '/other.md' }])
			)
			await vol.setXattr('/note.md', GHOSTORE_XATTR.source, encodeXattr('agent'))

			expect(decodeXattr(await vol.getXattr('/note.md', GHOSTORE_XATTR.title))).toBe('My Note')
			expect(decodeXattr(await vol.getXattr('/note.md', GHOSTORE_XATTR.tags))).toEqual([
				'fs',
				'xattr'
			])
			expect(decodeXattr(await vol.getXattr('/note.md', GHOSTORE_XATTR.links))).toEqual([
				{ rel: 'related', path: '/other.md' }
			])
			expect(decodeXattr(await vol.getXattr('/note.md', GHOSTORE_XATTR.source))).toBe('agent')
		})

		test('lists only xattrs that are set', async () => {
			const vol = makeVol()
			await vol.writeFile('/note.md', bytes('body'))
			await vol.setXattr('/note.md', GHOSTORE_XATTR.title, encodeXattr('My Note'))
			await vol.setXattr('/note.md', GHOSTORE_XATTR.tags, encodeXattr(['fs']))

			expect((await vol.listXattr('/note.md')).sort()).toEqual([
				GHOSTORE_XATTR.tags,
				GHOSTORE_XATTR.title
			])
		})

		test('removes an xattr and returns null afterwards', async () => {
			const vol = makeVol()
			await vol.writeFile('/note.md', bytes('body'))
			await vol.setXattr('/note.md', GHOSTORE_XATTR.title, encodeXattr('My Note'))

			await vol.removeXattr('/note.md', GHOSTORE_XATTR.title)

			expect(await vol.getXattr('/note.md', GHOSTORE_XATTR.title)).toBeNull()
			expect(await vol.listXattr('/note.md')).toEqual([])
		})

		test('follows the final symlink for xattr operations', async () => {
			const vol = makeVol()
			await vol.writeFile('/target.md', bytes('body'))
			await vol.symlink('/target.md', '/link.md')

			await vol.setXattr('/link.md', GHOSTORE_XATTR.tags, encodeXattr(['linked']))

			expect(decodeXattr(await vol.getXattr('/target.md', GHOSTORE_XATTR.tags))).toEqual(['linked'])
			expect(await vol.listXattr('/link.md')).toEqual([GHOSTORE_XATTR.tags])
		})
	})

	describe('rm', () => {
		test('removes a file', async () => {
			const vol = makeVol()
			await vol.writeFile('/f.txt', bytes(''))
			await vol.rm('/f.txt')
			expect(await vol.exists('/f.txt')).toBe(false)
		})

		test('removes an empty directory', async () => {
			const vol = makeVol()
			await vol.mkdir('/dir')
			await vol.rm('/dir')
			expect(await vol.exists('/dir')).toBe(false)
		})

		test('removes a symlink without touching its target', async () => {
			const vol = makeVol()
			await vol.writeFile('/target.txt', bytes('safe'))
			await vol.symlink('/target.txt', '/link.txt')
			await vol.rm('/link.txt')
			expect(await vol.exists('/link.txt')).toBe(false)
			expect(await vol.exists('/target.txt')).toBe(true)
		})

		test('throws ENOENT for a missing path', async () => {
			const vol = makeVol()
			await expect(vol.rm('/missing')).rejects.toThrow('ENOENT')
		})

		test('force silently ignores a missing path', async () => {
			const vol = makeVol()
			await expect(vol.rm('/missing', { force: true })).resolves.toBeUndefined()
		})

		test('throws ENOTEMPTY for a non-empty directory without recursive', async () => {
			const vol = makeVol()
			await vol.mkdir('/dir')
			await vol.writeFile('/dir/f.txt', bytes(''))
			await expect(vol.rm('/dir')).rejects.toThrow('ENOTEMPTY')
		})

		test('recursive removes a nested directory tree', async () => {
			const vol = makeVol()
			await vol.mkdir('/dir')
			await vol.writeFile('/dir/a.txt', bytes(''))
			await vol.mkdir('/dir/sub')
			await vol.writeFile('/dir/sub/b.txt', bytes(''))
			await vol.rm('/dir', { recursive: true })
			expect(await vol.exists('/dir')).toBe(false)
		})
	})

	describe('rename', () => {
		test('renames a file within the same directory', async () => {
			const vol = makeVol()
			await vol.writeFile('/old.txt', bytes('data'))
			await vol.rename('/old.txt', '/new.txt')
			expect(await vol.exists('/old.txt')).toBe(false)
			expect(str(await vol.readFile('/new.txt'))).toBe('data')
		})

		test('moves a file to a different directory', async () => {
			const vol = makeVol()
			await vol.mkdir('/dir')
			await vol.writeFile('/f.txt', bytes('data'))
			await vol.rename('/f.txt', '/dir/f.txt')
			expect(await vol.exists('/f.txt')).toBe(false)
			expect(str(await vol.readFile('/dir/f.txt'))).toBe('data')
		})

		test('overwrites the destination atomically', async () => {
			const vol = makeVol()
			await vol.writeFile('/a.txt', bytes('a'))
			await vol.writeFile('/b.txt', bytes('b'))
			await vol.rename('/a.txt', '/b.txt')
			expect(str(await vol.readFile('/b.txt'))).toBe('a')
			expect(await vol.exists('/a.txt')).toBe(false)
		})

		test('throws ENOENT for a missing source', async () => {
			const vol = makeVol()
			await expect(vol.rename('/missing.txt', '/new.txt')).rejects.toThrow('ENOENT')
		})
	})

	describe('cp', () => {
		test('copies a file, leaving the source intact', async () => {
			const vol = makeVol()
			await vol.writeFile('/src.txt', bytes('hello'))
			await vol.cp('/src.txt', '/dst.txt')
			expect(str(await vol.readFile('/dst.txt'))).toBe('hello')
			expect(await vol.exists('/src.txt')).toBe(true)
		})

		test('copy is independent — mutating dst does not affect src', async () => {
			const vol = makeVol()
			await vol.writeFile('/src.txt', bytes('original'))
			await vol.cp('/src.txt', '/dst.txt')
			await vol.writeFile('/dst.txt', bytes('modified'))
			expect(str(await vol.readFile('/src.txt'))).toBe('original')
		})

		test('recursive copies a directory tree', async () => {
			const vol = makeVol()
			await vol.mkdir('/src')
			await vol.writeFile('/src/a.txt', bytes('a'))
			await vol.mkdir('/src/sub')
			await vol.writeFile('/src/sub/b.txt', bytes('b'))
			await vol.cp('/src', '/dst', { recursive: true })
			expect(str(await vol.readFile('/dst/a.txt'))).toBe('a')
			expect(str(await vol.readFile('/dst/sub/b.txt'))).toBe('b')
		})

		test('throws when copying a directory without recursive', async () => {
			// The interface says recursive is "required" for directories but does not
			// mandate a specific error code for this case — only EISDIR/ENOTDIR for
			// type mismatches. Any rejection is conforming.
			const vol = makeVol()
			await vol.mkdir('/src')
			await expect(vol.cp('/src', '/dst')).rejects.toThrow()
		})

		test('recursive merges into an existing destination directory', async () => {
			const vol = makeVol()
			await vol.mkdir('/src')
			await vol.writeFile('/src/new.txt', bytes('new'))
			await vol.mkdir('/dst')
			await vol.writeFile('/dst/existing.txt', bytes('existing'))
			await vol.cp('/src', '/dst', { recursive: true })
			// pre-existing file in dst must survive
			expect(str(await vol.readFile('/dst/existing.txt'))).toBe('existing')
			// new file from src must appear
			expect(str(await vol.readFile('/dst/new.txt'))).toBe('new')
		})

		test('throws EISDIR when copying a file onto an existing directory', async () => {
			const vol = makeVol()
			await vol.writeFile('/src.txt', bytes('data'))
			await vol.mkdir('/dst')
			await expect(vol.cp('/src.txt', '/dst')).rejects.toThrow('EISDIR')
		})

		test('throws ENOTDIR when copying a directory onto an existing file', async () => {
			const vol = makeVol()
			await vol.mkdir('/src')
			await vol.writeFile('/dst.txt', bytes('data'))
			await expect(vol.cp('/src', '/dst.txt', { recursive: true })).rejects.toThrow('ENOTDIR')
		})
	})

	describe('symlink / readlink', () => {
		test('creates a symlink and reads its target back', async () => {
			const vol = makeVol()
			await vol.symlink('/target.txt', '/link.txt')
			expect(await vol.readlink('/link.txt')).toBe('/target.txt')
		})

		test('readFile follows the symlink to the target content', async () => {
			const vol = makeVol()
			await vol.writeFile('/target.txt', bytes('content'))
			await vol.symlink('/target.txt', '/link.txt')
			expect(str(await vol.readFile('/link.txt'))).toBe('content')
		})

		test('throws EEXIST when the link path already exists', async () => {
			const vol = makeVol()
			await vol.writeFile('/existing.txt', bytes(''))
			await expect(vol.symlink('/target', '/existing.txt')).rejects.toThrow('EEXIST')
		})

		test('readlink throws EINVAL for a non-symlink path', async () => {
			const vol = makeVol()
			await vol.writeFile('/f.txt', bytes(''))
			await expect(vol.readlink('/f.txt')).rejects.toThrow('EINVAL')
		})

		test('readlink throws ENOENT for a missing path', async () => {
			const vol = makeVol()
			await expect(vol.readlink('/missing')).rejects.toThrow('ENOENT')
		})
	})

	describe('chmod', () => {
		test('changes the mode bits of a file', async () => {
			const vol = makeVol()
			await vol.writeFile('/f.txt', bytes(''))
			await vol.chmod('/f.txt', 0o600)
			expect((await vol.stat('/f.txt')).mode & 0o777).toBe(0o600)
		})

		test('changes the mode bits of a directory', async () => {
			const vol = makeVol()
			await vol.mkdir('/dir')
			await vol.chmod('/dir', 0o700)
			expect((await vol.stat('/dir')).mode & 0o777).toBe(0o700)
		})

		test('follows symlinks — changes the target, not the link itself', async () => {
			const vol = makeVol()
			await vol.writeFile('/target.txt', bytes(''))
			await vol.symlink('/target.txt', '/link.txt')
			const linkModeBefore = (await vol.lstat('/link.txt')).mode
			await vol.chmod('/link.txt', 0o600)
			// stat follows the link: target mode changed
			expect((await vol.stat('/link.txt')).mode & 0o777).toBe(0o600)
			// lstat does not follow: symlink's own mode is unchanged
			expect((await vol.lstat('/link.txt')).mode).toBe(linkModeBefore)
		})
	})

	describe('utimes', () => {
		test('sets the mtime of a file', async () => {
			const vol = makeVol()
			await vol.writeFile('/f.txt', bytes(''))
			await vol.utimes('/f.txt', 999_000_000n)
			expect((await vol.stat('/f.txt')).mtimeNs).toBe(999_000_000n)
		})
	})

	describe('scan', () => {
		test('visits all nodes under the root, including the root itself', async () => {
			const vol = makeVol()
			await vol.mkdir('/a')
			await vol.writeFile('/a/x.txt', bytes(''))
			await vol.mkdir('/a/b')
			await vol.writeFile('/a/b/y.txt', bytes(''))

			const visited = []
			await vol.scan('/', async (path) => {
				visited.push(path)
			})
			expect(visited.sort()).toEqual(['/', '/a', '/a/b', '/a/b/y.txt', '/a/x.txt'])
		})

		test('visits directories before their contents', async () => {
			const vol = makeVol()
			await vol.mkdir('/dir')
			await vol.writeFile('/dir/child.txt', bytes(''))

			const visited = []
			await vol.scan('/', async (path) => {
				visited.push(path)
			})
			// '/' first, then '/dir' before its child
			expect(visited.indexOf('/')).toBeLessThan(visited.indexOf('/dir'))
			expect(visited.indexOf('/dir')).toBeLessThan(visited.indexOf('/dir/child.txt'))
		})

		test('scoped scan visits the root path itself and its subtree, not siblings', async () => {
			const vol = makeVol()
			await vol.writeFile('/root.txt', bytes(''))
			await vol.mkdir('/sub')
			await vol.writeFile('/sub/child.txt', bytes(''))

			const visited = []
			await vol.scan('/sub', async (path) => {
				visited.push(path)
			})
			expect(visited).toEqual(['/sub', '/sub/child.txt'])
		})

		test('visitor receives the stat for each node', async () => {
			const vol = makeVol()
			await vol.writeFile('/f.txt', bytes('hello'))

			const seen = new Map()
			await vol.scan('/', async (path, stat) => {
				seen.set(path, stat)
			})
			// root itself is visited
			expect(seen.get('/').type).toBe(FileType.Directory)
			// file is visited with correct metadata
			expect(seen.get('/f.txt').type).toBe(FileType.Regular)
			expect(seen.get('/f.txt').size).toBe(5n)
		})

		test('throws ENOENT for a missing path', async () => {
			const vol = makeVol()
			await expect(vol.scan('/missing', async () => {})).rejects.toThrow('ENOENT')
		})

		test('scoped scan through a symlinked directory visits children under the symlink path', async () => {
			const vol = makeVol()
			await vol.mkdir('/real')
			await vol.writeFile('/real/child.txt', bytes(''))
			await vol.symlink('/real', '/link')

			const visited = []
			await vol.scan('/link', async (path) => {
				visited.push(path)
			})
			expect(visited.sort()).toEqual(['/link', '/link/child.txt'])
		})

		test('scoped scan through a symlink to root visits all root children remapped under the symlink path', async () => {
			const vol = makeVol()
			await vol.writeFile('/top.txt', bytes(''))
			await vol.symlink('/', '/root-link')

			const visited = []
			await vol.scan('/root-link', async (path) => {
				visited.push(path)
			})
			// root has two children: top.txt and root-link itself
			expect(visited.sort()).toEqual(['/root-link', '/root-link/root-link', '/root-link/top.txt'])
		})
	})

	describe('writeFile / appendFile follow symlinks', () => {
		test('writeFile follows a symlink and writes to the target inode', async () => {
			const vol = makeVol()
			await vol.writeFile('/target.txt', bytes('original'))
			await vol.symlink('/target.txt', '/link.txt')
			await vol.writeFile('/link.txt', bytes('updated'))
			// target inode must hold the new content
			expect(str(await vol.readFile('/target.txt'))).toBe('updated')
			// the symlink itself must still point to the same target
			expect(await vol.readlink('/link.txt')).toBe('/target.txt')
		})

		test('appendFile follows a symlink and appends to the target inode', async () => {
			const vol = makeVol()
			await vol.writeFile('/target.txt', bytes('hello'))
			await vol.symlink('/target.txt', '/link.txt')
			await vol.appendFile('/link.txt', bytes(' world'))
			expect(str(await vol.readFile('/target.txt'))).toBe('hello world')
			expect(await vol.readlink('/link.txt')).toBe('/target.txt')
		})
	})

	describe('relative symlinks with ..', () => {
		test('readFile resolves a relative symlink containing ..', async () => {
			const vol = makeVol()
			await vol.mkdir('/a')
			await vol.mkdir('/b')
			await vol.writeFile('/b/file.txt', bytes('content'))
			// /a/link -> ../b/file.txt
			await vol.symlink('../b/file.txt', '/a/link')
			expect(str(await vol.readFile('/a/link'))).toBe('content')
		})

		test('stat follows a relative symlink containing ..', async () => {
			const vol = makeVol()
			await vol.mkdir('/a')
			await vol.mkdir('/b')
			await vol.writeFile('/b/file.txt', bytes('data'))
			await vol.symlink('../b/file.txt', '/a/link')
			expect((await vol.stat('/a/link')).type).toBe(FileType.Regular)
		})

		test('writeFile follows a relative symlink containing ..', async () => {
			const vol = makeVol()
			await vol.mkdir('/a')
			await vol.mkdir('/b')
			await vol.writeFile('/b/file.txt', bytes('old'))
			await vol.symlink('../b/file.txt', '/a/link')
			await vol.writeFile('/a/link', bytes('new'))
			expect(str(await vol.readFile('/b/file.txt'))).toBe('new')
		})

		test('lstat does not follow a relative symlink', async () => {
			const vol = makeVol()
			await vol.mkdir('/a')
			await vol.mkdir('/b')
			await vol.writeFile('/b/file.txt', bytes(''))
			await vol.symlink('../b/file.txt', '/a/link')
			expect((await vol.lstat('/a/link')).type).toBe(FileType.Symlink)
		})
	})
})

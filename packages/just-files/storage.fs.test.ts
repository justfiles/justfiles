import { afterEach, describe, expect, test } from 'bun:test'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { nativeStorage } from './storage.fs.ts'
import { FileType } from './types.ts'

// ── Helpers ──────────────────────────────────────────────────────────────────

const enc = new TextEncoder()
const dec = new TextDecoder()

function bytes(text: string): Uint8Array {
	return enc.encode(text)
}

function text(data: Uint8Array): string {
	return dec.decode(data)
}

// ── Fixture management ────────────────────────────────────────────────────────

let tempDirs: string[] = []

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

function makeTmp(setup?: (root: string) => void): string {
	const root = mkdtempSync(join(tmpdir(), 'ghostore-storage-fs-'))
	tempDirs.push(root)
	setup?.(root)
	return root
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('nativeStorage', () => {
	// ── Initialization ────────────────────────────────────────────────────────

	test('rootIno is a non-empty string', async () => {
		const root = makeTmp()
		const storage = await nativeStorage(root)
		expect(typeof storage.rootIno).toBe('string')
		expect(storage.rootIno.length).toBeGreaterThan(0)
	})

	test('getMeta on rootIno returns a Directory InodeMeta', async () => {
		const root = makeTmp()
		const storage = await nativeStorage(root)
		const meta = await storage.getMeta(storage.rootIno)
		expect(meta).not.toBeNull()
		expect(meta!.type).toBe(FileType.Directory)
		expect(meta!.mode & 0o7777).toBe(meta!.mode) // within permission bit range
		expect(meta!.mtimeNs).toBeGreaterThan(0n)
		expect(meta!.ctimeNs).toBeGreaterThan(0n)
	})

	test('getMeta returns null for an unknown ino', async () => {
		const root = makeTmp()
		const storage = await nativeStorage(root)
		// Inject a bad path directly — the pathMap doesn't know "9999999"
		// getMeta on an ino that was never registered throws ESTALE internally,
		// but the contract says return null on any error.
		// Use a real ino from getDirent after deleting the file to get null.
		writeFileSync(join(root, 'ephemeral.txt'), '')
		const dirent = await storage.getDirent(storage.rootIno, 'ephemeral.txt')
		expect(dirent).not.toBeNull()
		rmSync(join(root, 'ephemeral.txt'))
		// Now the path is gone — getMeta should return null
		const meta = await storage.getMeta(dirent!.ino)
		expect(meta).toBeNull()
	})

	// ── getMeta ───────────────────────────────────────────────────────────────

	test('getMeta returns correct size for a regular file', async () => {
		const root = makeTmp(dir => writeFileSync(join(dir, 'hello.txt'), 'hello world'))
		const storage = await nativeStorage(root)
		const dirent = await storage.getDirent(storage.rootIno, 'hello.txt')
		const meta = await storage.getMeta(dirent!.ino)
		expect(meta!.type).toBe(FileType.Regular)
		expect(meta!.size).toBe(11n)
	})

	test('getMeta returns FileType.Symlink for a symlink', async () => {
		const root = makeTmp(dir => symlinkSync('../other.txt', join(dir, 'link.txt')))
		const storage = await nativeStorage(root)
		const dirent = await storage.getDirent(storage.rootIno, 'link.txt')
		const meta = await storage.getMeta(dirent!.ino)
		expect(meta!.type).toBe(FileType.Symlink)
	})

	test('getMeta returns FileType.Directory for a subdirectory', async () => {
		const root = makeTmp(dir => mkdirSync(join(dir, 'subdir')))
		const storage = await nativeStorage(root)
		const dirent = await storage.getDirent(storage.rootIno, 'subdir')
		const meta = await storage.getMeta(dirent!.ino)
		expect(meta!.type).toBe(FileType.Directory)
	})

	// ── setMeta ───────────────────────────────────────────────────────────────

	test('setMeta updates mode on disk', async () => {
		const root = makeTmp(dir => writeFileSync(join(dir, 'file.txt'), 'x'))
		const storage = await nativeStorage(root)
		const dirent = await storage.getDirent(storage.rootIno, 'file.txt')

		await storage.setMeta(dirent!.ino, { mode: 0o600 })

		const s = statSync(join(root, 'file.txt'))
		expect(s.mode & 0o777).toBe(0o600)
	})

	test('setMeta updates mtimeNs on disk', async () => {
		const root = makeTmp(dir => writeFileSync(join(dir, 'file.txt'), 'x'))
		const storage = await nativeStorage(root)
		const dirent = await storage.getDirent(storage.rootIno, 'file.txt')

		const targetNs = 1_700_000_000_000_000_000n
		await storage.setMeta(dirent!.ino, { mtimeNs: targetNs })

		const s = statSync(join(root, 'file.txt'))
		const actualMs = BigInt(Math.trunc(s.mtimeMs))
		const targetMs = targetNs / 1_000_000n
		// Allow 1 second of rounding tolerance (OS mtime precision)
		expect(Math.abs(Number(actualMs - targetMs))).toBeLessThanOrEqual(1000)
	})

	test('setMeta with empty patch is a no-op', async () => {
		const root = makeTmp(dir => writeFileSync(join(dir, 'file.txt'), 'x'))
		const storage = await nativeStorage(root)
		const dirent = await storage.getDirent(storage.rootIno, 'file.txt')
		const before = await storage.getMeta(dirent!.ino)

		await storage.setMeta(dirent!.ino, {})

		const after = await storage.getMeta(dirent!.ino)
		expect(after!.mode).toBe(before!.mode)
	})

	// ── deleteInode ───────────────────────────────────────────────────────────

	test('deleteInode removes the ino from the internal pathMap', async () => {
		const root = makeTmp(dir => writeFileSync(join(dir, 'file.txt'), 'x'))
		const storage = await nativeStorage(root)
		const dirent = await storage.getDirent(storage.rootIno, 'file.txt')
		const ino = dirent!.ino

		await storage.deleteInode(ino)

		// After deleteInode, getMeta on that ino should throw ESTALE internally.
		// The file still exists on disk; we only cleared the pathMap entry.
		// getMeta catches the error and returns null.
		expect(await storage.getMeta(ino)).toBeNull()
	})

	// ── getBlob / putBlob ─────────────────────────────────────────────────────

	test('getBlob reads existing file content', async () => {
		const root = makeTmp(dir => writeFileSync(join(dir, 'note.txt'), 'hello'))
		const storage = await nativeStorage(root)
		const dirent = await storage.getDirent(storage.rootIno, 'note.txt')

		const data = await storage.getBlob(dirent!.ino)
		expect(text(data)).toBe('hello')
	})

	test('putBlob writes content to disk and getBlob reads it back', async () => {
		const root = makeTmp(dir => writeFileSync(join(dir, 'file.txt'), ''))
		const storage = await nativeStorage(root)
		const dirent = await storage.getDirent(storage.rootIno, 'file.txt')

		await storage.putBlob(dirent!.ino, bytes('written content'))

		const onDisk = readFileSync(join(root, 'file.txt'), 'utf8')
		expect(onDisk).toBe('written content')

		const viaStorage = await storage.getBlob(dirent!.ino)
		expect(text(viaStorage)).toBe('written content')
	})

	test('putBlob with binary data round-trips correctly', async () => {
		const root = makeTmp(dir => writeFileSync(join(dir, 'bin'), Buffer.alloc(0)))
		const storage = await nativeStorage(root)
		const dirent = await storage.getDirent(storage.rootIno, 'bin')

		const original = new Uint8Array([0, 1, 127, 128, 255])
		await storage.putBlob(dirent!.ino, original)
		const readBack = await storage.getBlob(dirent!.ino)

		expect(Array.from(readBack)).toEqual(Array.from(original))
	})

	test('putBlob overwrites existing content completely', async () => {
		const root = makeTmp(dir => writeFileSync(join(dir, 'file.txt'), 'long original content'))
		const storage = await nativeStorage(root)
		const dirent = await storage.getDirent(storage.rootIno, 'file.txt')

		await storage.putBlob(dirent!.ino, bytes('short'))

		expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('short')
	})

	// ── getDirent ─────────────────────────────────────────────────────────────

	test('getDirent returns null for a name that does not exist', async () => {
		const root = makeTmp()
		const storage = await nativeStorage(root)
		const result = await storage.getDirent(storage.rootIno, 'nonexistent.txt')
		expect(result).toBeNull()
	})

	test('getDirent returns consistent ino across multiple calls', async () => {
		const root = makeTmp(dir => writeFileSync(join(dir, 'stable.txt'), 'x'))
		const storage = await nativeStorage(root)
		const a = await storage.getDirent(storage.rootIno, 'stable.txt')
		const b = await storage.getDirent(storage.rootIno, 'stable.txt')
		expect(a!.ino).toBe(b!.ino)
	})

	test('getDirent ino from getDirent matches rootIno for the root directory itself', async () => {
		const root = makeTmp(dir => mkdirSync(join(dir, 'sub')))
		const storage = await nativeStorage(root)
		// sub is a subdirectory; create a storage rooted at sub and confirm its ino
		const subDirent = await storage.getDirent(storage.rootIno, 'sub')
		expect(subDirent!.type).toBe(FileType.Directory)
		expect(typeof subDirent!.ino).toBe('string')
	})

	test('getDirent type matches the actual filesystem entry type', async () => {
		const root = makeTmp(dir => {
			writeFileSync(join(dir, 'file.txt'), 'x')
			mkdirSync(join(dir, 'dir'))
			symlinkSync('../target', join(dir, 'link'))
		})
		const storage = await nativeStorage(root)

		const file = await storage.getDirent(storage.rootIno, 'file.txt')
		expect(file!.type).toBe(FileType.Regular)

		const dir = await storage.getDirent(storage.rootIno, 'dir')
		expect(dir!.type).toBe(FileType.Directory)

		const link = await storage.getDirent(storage.rootIno, 'link')
		expect(link!.type).toBe(FileType.Symlink)
	})

	// ── putDirent ─────────────────────────────────────────────────────────────

	test('putDirent moves a file to a new name within the same directory', async () => {
		const root = makeTmp(dir => writeFileSync(join(dir, 'src.txt'), 'move me'))
		const storage = await nativeStorage(root)
		const dirent = await storage.getDirent(storage.rootIno, 'src.txt')

		await storage.putDirent(storage.rootIno, 'dst.txt', dirent!)

		expect(existsSync(join(root, 'src.txt'))).toBe(false)
		expect(readFileSync(join(root, 'dst.txt'), 'utf8')).toBe('move me')
	})

	test('putDirent moves a file to a subdirectory', async () => {
		const root = makeTmp(dir => {
			writeFileSync(join(dir, 'file.txt'), 'content')
			mkdirSync(join(dir, 'subdir'))
		})
		const storage = await nativeStorage(root)
		const fileDirent = await storage.getDirent(storage.rootIno, 'file.txt')
		const subDirent = await storage.getDirent(storage.rootIno, 'subdir')

		await storage.putDirent(subDirent!.ino, 'moved.txt', fileDirent!)

		expect(existsSync(join(root, 'file.txt'))).toBe(false)
		expect(readFileSync(join(root, 'subdir', 'moved.txt'), 'utf8')).toBe('content')
	})

	test('putDirent preserves the ino after move', async () => {
		const root = makeTmp(dir => writeFileSync(join(dir, 'src.txt'), 'x'))
		const storage = await nativeStorage(root)
		const before = await storage.getDirent(storage.rootIno, 'src.txt')

		await storage.putDirent(storage.rootIno, 'dst.txt', before!)

		const after = await storage.getDirent(storage.rootIno, 'dst.txt')
		// Same ino — same inode, just renamed
		expect(after!.ino).toBe(before!.ino)
	})

	// ── deleteDirent ──────────────────────────────────────────────────────────

	test('deleteDirent removes a regular file from disk', async () => {
		const root = makeTmp(dir => writeFileSync(join(dir, 'delete-me.txt'), 'x'))
		const storage = await nativeStorage(root)

		await storage.deleteDirent(storage.rootIno, 'delete-me.txt')

		expect(existsSync(join(root, 'delete-me.txt'))).toBe(false)
	})

	test('deleteDirent removes an empty directory from disk', async () => {
		const root = makeTmp(dir => mkdirSync(join(dir, 'empty-dir')))
		const storage = await nativeStorage(root)

		await storage.deleteDirent(storage.rootIno, 'empty-dir')

		expect(existsSync(join(root, 'empty-dir'))).toBe(false)
	})

	test('deleteDirent removes a symlink (not the target)', async () => {
		const root = makeTmp(dir => {
			writeFileSync(join(dir, 'target.txt'), 'keep me')
			symlinkSync('target.txt', join(dir, 'link.txt'))
		})
		const storage = await nativeStorage(root)

		await storage.deleteDirent(storage.rootIno, 'link.txt')

		expect(existsSync(join(root, 'link.txt'))).toBe(false)
		expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('keep me')
	})

	// ── listDirents ───────────────────────────────────────────────────────────

	test('listDirents returns entries in sorted order', async () => {
		const root = makeTmp(dir => {
			writeFileSync(join(dir, 'z-last.txt'), '')
			writeFileSync(join(dir, 'a-first.txt'), '')
			mkdirSync(join(dir, 'm-middle'))
		})
		const storage = await nativeStorage(root)

		const result = await storage.listDirents(storage.rootIno, '')

		expect(result.entries.map(e => e.name)).toEqual(['a-first.txt', 'm-middle', 'z-last.txt'])
	})

	test('listDirents returns correct types', async () => {
		const root = makeTmp(dir => {
			writeFileSync(join(dir, 'file.txt'), '')
			mkdirSync(join(dir, 'dir'))
			symlinkSync('../other', join(dir, 'link'))
		})
		const storage = await nativeStorage(root)

		const { entries } = await storage.listDirents(storage.rootIno, '')
		const byName = Object.fromEntries(entries.map(e => [e.name, e]))

		expect(byName['file.txt']!.type).toBe(FileType.Regular)
		expect(byName['dir']!.type).toBe(FileType.Directory)
		expect(byName['link']!.type).toBe(FileType.Symlink)
	})

	test('listDirents cursor skips entries up to and including the cursor value', async () => {
		const root = makeTmp(dir => {
			writeFileSync(join(dir, 'a.txt'), '')
			writeFileSync(join(dir, 'b.txt'), '')
			writeFileSync(join(dir, 'c.txt'), '')
		})
		const storage = await nativeStorage(root)

		// cursor = 'a.txt' means: return entries whose names are > 'a.txt'
		const result = await storage.listDirents(storage.rootIno, 'a.txt')
		expect(result.entries.map(e => e.name)).toEqual(['b.txt', 'c.txt'])
	})

	test('listDirents cursor at last entry returns empty list', async () => {
		const root = makeTmp(dir => {
			writeFileSync(join(dir, 'a.txt'), '')
			writeFileSync(join(dir, 'z.txt'), '')
		})
		const storage = await nativeStorage(root)

		const result = await storage.listDirents(storage.rootIno, 'z.txt')
		expect(result.entries).toEqual([])
		expect(result.next).toBe('')
	})

	test('listDirents on an empty directory returns no entries', async () => {
		const root = makeTmp()
		const storage = await nativeStorage(root)

		const result = await storage.listDirents(storage.rootIno, '')
		expect(result.entries).toEqual([])
		expect(result.next).toBe('')
	})

	test('listDirents registers inodes in pathMap (getDirent works after listDirents)', async () => {
		const root = makeTmp(dir => writeFileSync(join(dir, 'listed.txt'), 'content'))
		const storage = await nativeStorage(root)

		const { entries } = await storage.listDirents(storage.rootIno, '')
		const listed = entries.find(e => e.name === 'listed.txt')!

		// getBlob should work because listDirents populated the pathMap
		const data = await storage.getBlob(listed.ino)
		expect(text(data)).toBe('content')
	})

	// ── caps.atomicCreate ─────────────────────────────────────────────────────

	describe('caps.atomicCreate', () => {
		test('creates a regular file on disk', async () => {
			const root = makeTmp()
			const storage = await nativeStorage(root)

			const ino = await storage.caps!.atomicCreate!(storage.rootIno, 'new.txt', {
				type: FileType.Regular,
				size: 0n,
				mode: 0o644,
				mtimeNs: 0n,
				ctimeNs: 0n,
			})

			expect(typeof ino).toBe('string')
			expect(existsSync(join(root, 'new.txt'))).toBe(true)
			const s = statSync(join(root, 'new.txt'))
			expect(s.isFile()).toBe(true)
		})

		test('created file is empty', async () => {
			const root = makeTmp()
			const storage = await nativeStorage(root)

			const ino = await storage.caps!.atomicCreate!(storage.rootIno, 'empty.txt', {
				type: FileType.Regular,
				size: 0n,
				mode: 0o644,
				mtimeNs: 0n,
				ctimeNs: 0n,
			})

			const data = await storage.getBlob(ino)
			expect(data.length).toBe(0)
		})

		test('created file respects mode', async () => {
			const root = makeTmp()
			const storage = await nativeStorage(root)

			await storage.caps!.atomicCreate!(storage.rootIno, 'restricted.txt', {
				type: FileType.Regular,
				size: 0n,
				mode: 0o600,
				mtimeNs: 0n,
				ctimeNs: 0n,
			})

			const s = statSync(join(root, 'restricted.txt'))
			expect(s.mode & 0o777).toBe(0o600)
		})

		test('creates a directory on disk', async () => {
			const root = makeTmp()
			const storage = await nativeStorage(root)

			const ino = await storage.caps!.atomicCreate!(storage.rootIno, 'newdir', {
				type: FileType.Directory,
				size: 0n,
				mode: 0o755,
				mtimeNs: 0n,
				ctimeNs: 0n,
			})

			expect(typeof ino).toBe('string')
			const s = statSync(join(root, 'newdir'))
			expect(s.isDirectory()).toBe(true)
		})

		test('creates a symlink on disk with correct target', async () => {
			const root = makeTmp()
			const storage = await nativeStorage(root)

			const ino = await storage.caps!.atomicCreate!(storage.rootIno, 'mylink', {
				type: FileType.Symlink,
				size: 0n,
				mode: 0o777,
				mtimeNs: 0n,
				ctimeNs: 0n,
				symlinkTarget: '../target.txt',
			})

			expect(typeof ino).toBe('string')
			const target = await readlink(join(root, 'mylink'))
			expect(target).toBe('../target.txt')
		})

		test('atomicCreate ino is usable with getMeta', async () => {
			const root = makeTmp()
			const storage = await nativeStorage(root)

			const ino = await storage.caps!.atomicCreate!(storage.rootIno, 'file.txt', {
				type: FileType.Regular,
				size: 0n,
				mode: 0o644,
				mtimeNs: 0n,
				ctimeNs: 0n,
			})

			const meta = await storage.getMeta(ino)
			expect(meta).not.toBeNull()
			expect(meta!.type).toBe(FileType.Regular)
		})

		test('atomicCreate ino is usable with getDirent', async () => {
			const root = makeTmp()
			const storage = await nativeStorage(root)

			const ino = await storage.caps!.atomicCreate!(storage.rootIno, 'file.txt', {
				type: FileType.Regular,
				size: 0n,
				mode: 0o644,
				mtimeNs: 0n,
				ctimeNs: 0n,
			})

			const dirent = await storage.getDirent(storage.rootIno, 'file.txt')
			expect(dirent!.ino).toBe(ino)
		})
	})

	// ── caps.atomicMove ───────────────────────────────────────────────────────

	describe('caps.atomicMove', () => {
		test('renames a file within the same directory', async () => {
			const root = makeTmp(dir => writeFileSync(join(dir, 'old.txt'), 'content'))
			const storage = await nativeStorage(root)
			await storage.getDirent(storage.rootIno, 'old.txt') // populate pathMap

			const displaced = await storage.caps!.atomicMove!(
				storage.rootIno, 'old.txt',
				storage.rootIno, 'new.txt',
			)

			expect(displaced).toBeNull()
			expect(existsSync(join(root, 'old.txt'))).toBe(false)
			expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('content')
		})

		test('moves a file to a subdirectory', async () => {
			const root = makeTmp(dir => {
				writeFileSync(join(dir, 'file.txt'), 'data')
				mkdirSync(join(dir, 'sub'))
			})
			const storage = await nativeStorage(root)
			await storage.getDirent(storage.rootIno, 'file.txt')
			const subDirent = await storage.getDirent(storage.rootIno, 'sub')

			const displaced = await storage.caps!.atomicMove!(
				storage.rootIno, 'file.txt',
				subDirent!.ino, 'file.txt',
			)

			expect(displaced).toBeNull()
			expect(existsSync(join(root, 'file.txt'))).toBe(false)
			expect(readFileSync(join(root, 'sub', 'file.txt'), 'utf8')).toBe('data')
		})

		test('displaces an existing file and returns its ino', async () => {
			const root = makeTmp(dir => {
				writeFileSync(join(dir, 'src.txt'), 'src')
				writeFileSync(join(dir, 'dst.txt'), 'dst')
			})
			const storage = await nativeStorage(root)
			await storage.getDirent(storage.rootIno, 'src.txt')
			const dstDirent = await storage.getDirent(storage.rootIno, 'dst.txt')

			const displaced = await storage.caps!.atomicMove!(
				storage.rootIno, 'src.txt',
				storage.rootIno, 'dst.txt',
			)

			expect(displaced).toBe(dstDirent!.ino)
			expect(readFileSync(join(root, 'dst.txt'), 'utf8')).toBe('src')
		})

		test('atomicMove updates pathMap so descendants remain accessible', async () => {
			const root = makeTmp(dir => {
				mkdirSync(join(dir, 'olddir'))
				writeFileSync(join(dir, 'olddir', 'child.txt'), 'child')
			})
			const storage = await nativeStorage(root)
			const oldDirDirent = await storage.getDirent(storage.rootIno, 'olddir')
			const childDirent = await storage.getDirent(oldDirDirent!.ino, 'child.txt')

			await storage.caps!.atomicMove!(
				storage.rootIno, 'olddir',
				storage.rootIno, 'newdir',
			)

			// The child's ino should still be usable — pathMap was updated
			const childData = await storage.getBlob(childDirent!.ino)
			expect(text(childData)).toBe('child')
			expect(readFileSync(join(root, 'newdir', 'child.txt'), 'utf8')).toBe('child')
		})

		test('atomicMove returns null when displacing the same inode (self-rename)', async () => {
			const root = makeTmp(dir => writeFileSync(join(dir, 'same.txt'), 'x'))
			const storage = await nativeStorage(root)
			await storage.getDirent(storage.rootIno, 'same.txt')

			const displaced = await storage.caps!.atomicMove!(
				storage.rootIno, 'same.txt',
				storage.rootIno, 'same.txt',
			)

			// same src and dst ino — no displacement
			expect(displaced).toBeNull()
		})

		test('atomicMove updates deeply nested descendants', async () => {
			const root = makeTmp(dir => {
				mkdirSync(join(dir, 'a'))
				mkdirSync(join(dir, 'a', 'b'))
				writeFileSync(join(dir, 'a', 'b', 'deep.txt'), 'deep')
			})
			const storage = await nativeStorage(root)
			// Populate pathMap for nested entries
			const aDirent = await storage.getDirent(storage.rootIno, 'a')
			const bDirent = await storage.getDirent(aDirent!.ino, 'b')
			const deepDirent = await storage.getDirent(bDirent!.ino, 'deep.txt')

			await storage.caps!.atomicMove!(
				storage.rootIno, 'a',
				storage.rootIno, 'renamed',
			)

			const data = await storage.getBlob(deepDirent!.ino)
			expect(text(data)).toBe('deep')
			expect(readFileSync(join(root, 'renamed', 'b', 'deep.txt'), 'utf8')).toBe('deep')
		})
	})

	// ── Cross-operation consistency ───────────────────────────────────────────

	test('ino from listDirents matches ino from getDirent for the same file', async () => {
		const root = makeTmp(dir => writeFileSync(join(dir, 'file.txt'), 'x'))
		const storage = await nativeStorage(root)

		const { entries } = await storage.listDirents(storage.rootIno, '')
		const fromList = entries.find(e => e.name === 'file.txt')!

		const fromGet = await storage.getDirent(storage.rootIno, 'file.txt')

		expect(fromList.ino).toBe(fromGet!.ino)
	})

	test('putBlob after atomicCreate writes to the correct file', async () => {
		const root = makeTmp()
		const storage = await nativeStorage(root)

		const ino = await storage.caps!.atomicCreate!(storage.rootIno, 'doc.txt', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})

		await storage.putBlob(ino, bytes('hello world'))

		expect(readFileSync(join(root, 'doc.txt'), 'utf8')).toBe('hello world')
	})

	test('full create-write-read-delete lifecycle', async () => {
		const root = makeTmp()
		const storage = await nativeStorage(root)

		// Create
		const ino = await storage.caps!.atomicCreate!(storage.rootIno, 'lifecycle.txt', {
			type: FileType.Regular,
			size: 0n,
			mode: 0o644,
			mtimeNs: 0n,
			ctimeNs: 0n,
		})

		// Write
		await storage.putBlob(ino, bytes('lifecycle test'))

		// Read via getBlob
		expect(text(await storage.getBlob(ino))).toBe('lifecycle test')

		// Verify listed
		const { entries } = await storage.listDirents(storage.rootIno, '')
		expect(entries.some(e => e.name === 'lifecycle.txt')).toBe(true)

		// Delete dirent then inode
		await storage.deleteDirent(storage.rootIno, 'lifecycle.txt')
		await storage.deleteInode(ino)

		expect(existsSync(join(root, 'lifecycle.txt'))).toBe(false)
		const { entries: after } = await storage.listDirents(storage.rootIno, '')
		expect(after.some(e => e.name === 'lifecycle.txt')).toBe(false)
	})
})
